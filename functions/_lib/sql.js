// ============================================================
// 数据库导出（Ver 0.6 ⑦）：把整个 D1 库导成「能直接导入」的 .sql
// ------------------------------------------------------------
// 三条设计原则：
//
// 1. 建表 / 建索引语句**直接取 sqlite_master 的原文**，不在代码里手抄一份 schema。
//    这样永远不会出现「改了迁移、忘了改导出代码」的漂移。
//
// 2. 不碰 PRAGMA。列名、以及「哪些列参与了索引」全部从 DDL 原文解析出来
//    —— 少一层对「D1 到底放行哪个 PRAGMA」的依赖。
//
// 3. 三种方言共用同一份数据，只有 DDL 与字面量转义走不同分支。
//    - sqlite：DDL 原样照抄，字符串只需把 `'` 写成 `''`。
//    - mysql ：必须翻译。差别都在 mysqlColumn()/约束改写里，逐条有注释。
//    - pg    ：列级只需翻译「自增主键」一处 —— TEXT 在 PG 可以直接进索引
//              （不像 MySQL 要报 1170），也没有 ENGINE / 字符集那套尾巴。
//              但**收尾必须按表补 setval 重设序列**，否则导入后第一次不指定 id 的
//              INSERT 就会主键冲突（PG 的序列不会因为显式插入了 id 而前进）。
//
// ⚠️ 加 pg 方言的硬约束：sqlite / mysql 的产物**已经上线验证过**，
//    任何改动都不许让它们产生字节变化。`.tmp/dump-baseline.mjs` 逐字节比对守着这条。
//
// ⚠️ 为什么不用 Cloudflare 官方的 D1 export 接口：
//    官方文档写明「A running export will block other database requests」，
//    导出期间整个库拒绝一切查询 —— 对一个正在被读者访问的博客来说就是停站。
//    而且它要 Account ID / Database ID / 重新授权的 Token 三个新密钥，
//    输出还只有 SQLite 一种，MySQL 那边照样得自己翻。所以统一自己生成。
// ============================================================

// D1 的内部表，不算站点数据，导出去只会给导入添乱
const SKIP_TABLE = (n) =>
  n.startsWith('sqlite_') || n.startsWith('_cf_') || n === 'd1_migrations';

// 方言别名的归一表：postgres / postgresql / pgsql 都指同一个东西。
// ★ 归一必须发生在**最外层**，并把归一后的结果往下传 —— 否则别名会在 literal() /
//   insertStatements() 里匹配不上 pg 分支，静默退化成 SQLite 的字面量规则。
// ★ 这个函数**导出**给 functions/[[path]].js 的路由用，全项目只此一份 ——
//   本站踩过「同一条判定写两份、改漏一处」的坑（见 Ver 0.6 ⑤ 的 isEditorHash）。
const PG_ALIAS = new Set(['pg', 'postgres', 'postgresql', 'pgsql']);
export const normalizeFmt = (d) =>
  (d === 'mysql' ? 'mysql' : PG_ALIAS.has(String(d || '').toLowerCase()) ? 'pg' : 'sqlite');

// 反引号包裹标识符。本项目实测有 12 个列名撞上 MySQL 的保留字/关键字
// （key / status / type / sort / source / day / password / link / name / url / value / ok），
// 不包反引号 MySQL 直接语法错误，所以**一律全包**，不挑。
const q = (id) => '`' + String(id).replace(/`/g, '``') + '`';

// PG 用双引号。本项目表名/列名本来就全小写（PG 不加引号时会折叠成小写，所以其实
// 加不加都安全），这里加引号只是保险 —— 尤其那 12 个撞 MySQL 保留字的列名。
// ⚠️ 双引号在 PG 里是**大小写敏感**的，所以内部的双引号必须双写。
// ⚠️ SQLite 侧刻意**继续用反引号**（SQLite 认这是 MySQL 兼容写法）：既然已验证过、
//    能正常导入，就不为了「更标准」去动它 —— 无谓的改动等于白担风险。
const qpg = (id) => '"' + String(id).replace(/"/g, '""') + '"';

// 按方言引用一个标识符。**全项目只此一份** —— targets.js（目标程序导出）也要用，
// 它要是自己再抄一个 pg 判断，就是在重复 Ver 0.6 ⑤ isEditorHash 那个坑。
export const quoteIdent = (fmt, id) => (fmt === 'pg' ? qpg(id) : q(id));

// 按「顶层逗号」切分，括号内的逗号不算 —— `PRIMARY KEY(a, b)` 不能被切坏
function splitTop(s) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of String(s)) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

// 从 `(a, b DESC)` 里取出列名数组（去掉引号与排序方向）
const colList = (s) => splitTop(s)
  .map((x) => x.trim().replace(/\s+(?:ASC|DESC)$/i, '').trim())
  .map((x) => x.replace(/^[`"[]/, '').replace(/[`"\]]$/, ''))
  .filter(Boolean);

// 从 `(a, b DESC)` 里取出「列名 + 方向」，MySQL 建索引时要保留 DESC
const colListWithDir = (s) => splitTop(s).map((x) => {
  const m = /^(.*?)\s*(ASC|DESC)?$/i.exec(x.trim());
  return { col: m[1].replace(/^[`"[]/, '').replace(/[`"\]]$/, ''), dir: (m[2] || '').toUpperCase() };
});

// ---------- DDL 解析 ----------

// 剥掉 SQL 注释。
// ★ 我们解析的是 sqlite_master 里的 DDL **原文**，它完全可能带行内注释 ——
//    migrations/0001_init.sql 里就有两处：
//      status TEXT NOT NULL DEFAULT 'draft',   -- draft | published
//      status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | trash
//    不剥的话：列定义是按逗号切的，注释会跟着逗号跑到**下一个列定义**的前面
//    （"-- draft | published\n  category_id  INTEGER"），列名正则 `^[\w$]+` 从 `-`
//    起头匹配不上 → 这一列被**静默丢掉**，而表级外键还指着它
//    （MySQL 导入时直接 ERROR 1072: Key column doesn't exist in table）。
//    实测被丢掉的是 posts.category_id 与 comments.is_admin 两列。
// ★ 必须走扫描、不能一句 `/--.*$/gm` 了事：单引号里完全可能自带 `--`（默认值就常有），
//    而且三种引号（' " `）内部都不算注释。
function stripComments(s) {
  let out = '';
  let qch = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const nx = s[i + 1];
    if (qch) {
      out += ch;
      if (ch === qch) { if (nx === qch) { out += s[++i]; continue; } qch = null; }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { qch = ch; out += ch; continue; }
    if (ch === '-' && nx === '-') { while (i < s.length && s[i] !== '\n') i++; out += '\n'; continue; }
    if (ch === '/' && nx === '*') {
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++;
      i++;                       // 跳过 `*/`
      out += ' ';                // 留个空格，免得前后两个 token 粘成一个
      continue;
    }
    out += ch;
  }
  return out;
}

// MySQL 系建表脚本里的**表级索引定义**一行，形如：
//   KEY `cid` (`cid`)          INDEX idx (a, b)          FULLTEXT KEY ft (title)
//   KEY meta_key (meta_key(191))        ← 名字后面**嵌套括号**是 WordPress 的写法
// ⚠️ 判据必须带上「整段以 `)` 收尾」，**不能只看行首关键字**：
//    项目自己的建表脚本里 `settings` 表就有一个列写作 `key   TEXT PRIMARY KEY`
//    （SQLite 允许裸 `key` 当列名），只认行首会把这**一列**当成表级约束**静默丢掉**。
//    带上收尾条件就分得开 —— 列定义后面不是跟着类型就是跟着约束，绝不会在 `)` 处结束；
//    而反过来的 `key varchar(191)`（名叫 key 的列、且不带任何其他子句）是理论边缘，
//    实际不会出现：我们导出的 DDL 里标识符一律带引号，`` `key` `` 打头根本匹配不上。
const INDEX_DEF_RE = /^(?:FULLTEXT|SPATIAL)?\s*(?:KEY|INDEX)\s*(?:[`"[]?[\w$%]+[`"\]]?)?\s*\([\s\S]*\)\s*(?:USING\s+\w+)?\s*$/i;

// CREATE TABLE 原文 → { name, cols, extras, fks, pkCols }
//   cols   : 列定义，`rest` 是「类型 + 约束」那段原文（保留大小写与 DEFAULT）
//   extras : 表级约束原文（PRIMARY KEY(...) / FOREIGN KEY(...)）
//   fks    : 列内联外键，已从列定义里摘出来（MySQL 会静默忽略列内联写法，必须提到表级）
function parseTable(ddl) {
  const raw = String(ddl).trim();
  const m = /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"[]?([\w$]+)[`"\]]?\s*\(([\s\S]*)\)\s*$/i.exec(raw);
  if (!m) return null;
  const name = m[1];
  const cols = [];
  const extras = [];
  const fks = [];
  const pkCols = [];
  const refs = [];        // 本表引用到的所有表名（列内联 + 表级都算），拓扑排序用
  for (const part of splitTop(stripComments(m[2]))) {
    if (/^(?:CONSTRAINT\s+\S+\s+)?(?:PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK)\b/i.test(part)
        || INDEX_DEF_RE.test(part)) {
      extras.push(part);
      const pk = /^(?:CONSTRAINT\s+\S+\s+)?PRIMARY\s+KEY\s*\(([^)]*)\)/i.exec(part);
      if (pk) pkCols.push(...colList(pk[1]));
      // ⚠️ 表级 FOREIGN KEY 也要记进依赖。只认「列内联 REFERENCES」的话，
      //    posts → categories 这种表级写法会被漏掉，排序就退化成「碰巧字母序对了」。
      const tfk = /^FOREIGN\s+KEY\s*\([^)]*\)\s*REFERENCES\s+[`"[]?([\w$]+)/i.exec(part.trim());
      if (tfk) refs.push(tfk[1]);
      continue;
    }
    const cm = /^[`"[]?([\w$]+)[`"\]]?\s+([\s\S]+)$/.exec(part);
    if (!cm) continue;
    const colName = cm[1];
    let rest = cm[2].trim();
    const rm = /\s*REFERENCES\s+[`"[]?([\w$]+)[`"\]]?\s*\(\s*([^)]*)\s*\)(\s+ON\s+(?:DELETE|UPDATE)\s+(?:CASCADE|SET\s+NULL|SET\s+DEFAULT|RESTRICT|NO\s+ACTION))?/i.exec(rest);
    if (rm) {
      refs.push(rm[1]);
      fks.push({
        col: colName,
        ref: rm[1],
        refCols: colList(rm[2]),
        onDelete: rm[3] ? rm[3].trim().replace(/\s+/g, ' ').toUpperCase() : '',
      });
      rest = (rest.slice(0, rm.index) + rest.slice(rm.index + rm[0].length)).trim();
    }
    const isPk = /\bPRIMARY\s+KEY\b/i.test(rest);
    const isUq = /\bUNIQUE\b/i.test(rest);
    if (isPk) pkCols.push(colName);
    cols.push({ name: colName, type: (/^([A-Za-z]+)/.exec(rest) || [, ''])[1].toUpperCase(), rest, isPk, isUq });
  }
  return { name, raw, cols, extras, fks, pkCols, refs };
}

// CREATE INDEX 原文 → { name, table, unique, cols:[{col,dir}] }
// 与 parseTable 同理：先剥注释再解析列清单，否则 `(status, -- 说明\n published_at DESC)`
// 里的第一个列名会带上注释、匹配不出正确列名。raw 仍保留原文（SQLite 侧照抄）。
function parseIndex(ddl) {
  const raw = String(ddl).trim();
  const m = /^\s*CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"[]?([\w$]+)[`"\]]?\s+ON\s+[`"[]?([\w$]+)[`"\]]?\s*\(([\s\S]*)\)\s*$/i.exec(stripComments(raw));
  if (!m) return null;
  return { unique: !!m[1], name: m[2], table: m[3], raw, cols: colListWithDir(m[4]) };
}

// 从「一坨完整的建表 SQL」（用户上传的目标程序安装脚本）里抽出每张表的表名与列名。
// 用途见 targets.js 的 schema 覆盖：只用来**学表名与列名**，DDL 本身一律丢弃不输出。
// ★ 必须走括号配对扫描，不能拿正则切分：
//     WordPress 的 `KEY meta_key (meta_key(191))` 是嵌套括号，
//     Typecho 的 `)` 后面还跟着 `ENGINE=%engine% DEFAULT CHARSET=%charset%;`，
//     懒惰正则 `\(([\s\S]*?)\)` 会从第一个 `(` 匹配到**内层**那个 `)`，整列清单就截断了。
export function tableColumns(sqlText) {
  const text = stripComments(String(sqlText || ''));
  const out = [];
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"[]?[\w$]+[`"\]]?)\s*\(/gi;
  let m;
  while ((m = re.exec(text))) {
    const open = re.lastIndex - 1;          // 指向那个 '('
    let depth = 0;
    let i = open;
    let q = null;
    for (; i < text.length; i++) {
      const ch = text[i];
      if (q) { if (ch === q) { if (text[i + 1] === q) i++; else q = null; } continue; }
      if (ch === "'" || ch === '"' || ch === '`') { q = ch; continue; }
      if (ch === '(') depth++;
      else if (ch === ')' && --depth === 0) break;
    }
    const def = parseTable(text.slice(m.index, i + 1));
    if (def) out.push({ name: def.name, cols: def.cols.map((c) => c.name) });
    re.lastIndex = i + 1;
  }
  return out;
}

// ============ MySQL 方言翻译 ============
//
// MySQL 侧列宽。**只对「参与索引的 TEXT 列」生效** —— MySQL 不许 TEXT/LONGTEXT 直接进
// 索引（ERROR 1170: BLOB/TEXT column used in key specification without a key length），
// 这些列必须换成 VARCHAR(n)。
// 取值原则：够用即止，宁可宽一点也别在导入时被截断。
// 复合索引的键长上限是 3072 字节（InnoDB + DYNAMIC 行格式），utf8mb4 下 1 字符 = 4 字节：
//   最宽的一处是 idx_fpost_uniq(feed_id INT, guid 700) = 4 + 700*4 = 2804 < 3072 ✓
const MY_LEN = {
  'settings.key': 191, 'categories.slug': 191, 'tags.slug': 191, 'posts.slug': 191,
  'pv_daily.day': 32, 'pv_visitor.day': 32, 'pv_visitor.vid': 64, 'post_likes.vid': 64,
  'ip_geo.ip': 64, 'comments.ip': 64,
  'posts.status': 32, 'posts.type': 32, 'comments.status': 32, 'links.status': 32,
  'posts.published_at': 40, 'friend_posts.published_at': 40,
  'links.url': 700, 'friend_posts.guid': 700,
};
const MY_LEN_DEFAULT = 255;

// 单列定义 → MySQL 单列定义
function mysqlColumn(c, table, indexed) {
  let t = c.rest;
  // INTEGER PRIMARY KEY AUTOINCREMENT 是 SQLite 的「自增主键」写法，MySQL 叫 AUTO_INCREMENT。
  // 必须先于下面的 INTEGER 替换判断，否则会被先改掉再匹配不上。
  if (/^INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/i.test(t)) {
    return t.replace(/^INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/i, 'INT NOT NULL AUTO_INCREMENT PRIMARY KEY');
  }
  if (/^INTEGER\s+PRIMARY\s+KEY\b/i.test(t)) {
    return t.replace(/^INTEGER\s+PRIMARY\s+KEY\b/i, 'INT NOT NULL PRIMARY KEY');
  }
  if (/^TEXT\b/i.test(t)) {
    if (indexed.has(c.name)) {
      // 参与索引 → VARCHAR，DEFAULT 可以保留（VARCHAR 允许字面量默认值）
      const n = MY_LEN[table + '.' + c.name] || MY_LEN_DEFAULT;
      return t.replace(/^TEXT\b/i, 'VARCHAR(' + n + ')');
    }
    // 不参与索引 → LONGTEXT，但必须**去掉 DEFAULT 子句**：
    // MySQL 8.0.13 以下 BLOB/TEXT 根本不允许默认值，8.0.13+ 也要求写成 `DEFAULT ('')` 这种表达式形式，
    // 裸的 `DEFAULT ''` 照样报错。反正 INSERT 每列都给了值，默认值对导入保真没影响。
    return t.replace(/^TEXT\b/i, 'LONGTEXT').replace(/\s+DEFAULT\s+(?:'(?:[^']|'')*'|"[^"]*"|[^\s,]+)/i, '');
  }
  return t.replace(/^INTEGER\b/i, 'INT');
}

// 表级约束 → MySQL
function mysqlConstraint(e) {
  const s = e.trim();
  let m = /^(?:CONSTRAINT\s+(\S+)\s+)?PRIMARY\s+KEY\s*\(([^)]*)\)\s*$/i.exec(s);
  if (m) return (m[1] ? 'CONSTRAINT ' + q(m[1]) + ' ' : '') + 'PRIMARY KEY (' + colList(m[2]).map(q).join(', ') + ')';
  m = /^(?:CONSTRAINT\s+(\S+)\s+)?FOREIGN\s+KEY\s*\(([^)]*)\)\s*REFERENCES\s+[`"[]?([\w$]+)[`"\]]?\s*\(([^)]*)\)\s*(.*)$/i.exec(s);
  if (m) {
    return (m[1] ? 'CONSTRAINT ' + q(m[1]) + ' ' : '')
      + 'FOREIGN KEY (' + colList(m[2]).map(q).join(', ') + ')'
      + ' REFERENCES ' + q(m[3]) + ' (' + colList(m[4]).map(q).join(', ') + ')'
      + (m[5] ? ' ' + m[5].trim().replace(/\s+/g, ' ').toUpperCase() : '');
  }
  m = /^(?:CONSTRAINT\s+(\S+)\s+)?UNIQUE\s*\(([^)]*)\)\s*$/i.exec(s);
  if (m) return (m[1] ? 'CONSTRAINT ' + q(m[1]) + ' ' : '') + 'UNIQUE (' + colList(m[2]).map(q).join(', ') + ')';
  return s;
}

// 整张表 → MySQL 建表语句
function mysqlTable(def, indexed) {
  const lines = def.cols.map((c) => '  ' + q(c.name) + ' ' + mysqlColumn(c, def.name, indexed));
  for (const e of def.extras) lines.push('  ' + mysqlConstraint(e));
  for (const f of def.fks) {
    lines.push('  FOREIGN KEY (' + q(f.col) + ') REFERENCES ' + q(f.ref)
      + ' (' + f.refCols.map(q).join(', ') + ')' + (f.onDelete ? ' ' + f.onDelete : ''));
  }
  return 'DROP TABLE IF EXISTS ' + q(def.name) + ';\n'
    + 'CREATE TABLE ' + q(def.name) + ' (\n' + lines.join(',\n') + '\n)'
    + ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;';
}

function mysqlIndex(ix) {
  return 'CREATE ' + (ix.unique ? 'UNIQUE ' : '') + 'INDEX ' + q(ix.name) + ' ON ' + q(ix.table)
    + ' (' + ix.cols.map((c) => q(c.col) + (c.dir ? ' ' + c.dir : '')).join(', ') + ');';
}

// ============ PostgreSQL 方言翻译 ============
//
// PG 侧**列定义里只需要翻译一处**：自增主键。其余全部原样通过 ——
//   · TEXT 保持 TEXT：PG 的 btree 允许文本列直接进索引，没有 MySQL 1170 那回事；
//   · DEFAULT '' / DEFAULT 0 这类字面量默认值 PG 全认；
//   · 列内联 REFERENCES ... ON DELETE CASCADE PG 也认（MySQL 会**静默忽略**、PG 不会），
//     所以**不需要**像 mysqlTable() 那样把外键提到表级。
// 也就是说 PG 是三种方言里最省事的一种。真正的坑在「序列」上，见下面的 setvalStatement()。

// 单列定义 → PG 单列定义
function pgColumn(c) {
  const t = c.rest;
  // 自增主键：SQLite 的 AUTOINCREMENT 对应 PG 的 IDENTITY 列（PG 10+，标准写法）。
  // 用 BY DEFAULT 而不是 ALWAYS —— ALWAYS 会拒绝显式写 id（除非加 OVERRIDING SYSTEM
  // VALUE），而我们恰恰要把 id 原样搬过去。
  // ⚠️ 这条判断必须排在别的 INTEGER 规则之前（这里目前没有别的 INTEGER 规则，
  //    但 MySQL 那边踩过「先被一般规则改掉、再匹配不上」的坑，留着提醒）。
  if (/^INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/i.test(t)) {
    return t.replace(/^INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/i, 'INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY');
  }
  // ⚠️ PG 没有 `BLOB` 这个类型名，对应的是 BYTEA。本项目 schema 里确实没有 BLOB 列
  //    （二进制全放 R2），这里是防御性映射 —— 万一以后加了 BLOB 列，
  //    不映射就会生成一个 PG 根本不认的类型，整个导入从第一张表就挂。
  //    literal() 那边对二进制值输出 decode('..','hex')，正好是 bytea 的合法写法。
  if (/^BLOB\b/i.test(t)) return t.replace(/^BLOB\b/i, 'BYTEA');
  return t;
}

// 表级约束 → PG。结构照抄 mysqlConstraint，只是引号换成双引号
function pgConstraint(e) {
  const s = e.trim();
  let m = /^(?:CONSTRAINT\s+(\S+)\s+)?PRIMARY\s+KEY\s*\(([^)]*)\)\s*$/i.exec(s);
  if (m) return (m[1] ? 'CONSTRAINT ' + qpg(m[1]) + ' ' : '') + 'PRIMARY KEY (' + colList(m[2]).map(qpg).join(', ') + ')';
  m = /^(?:CONSTRAINT\s+(\S+)\s+)?FOREIGN\s+KEY\s*\(([^)]*)\)\s*REFERENCES\s+[`"[]?([\w$]+)[`"\]]?\s*\(([^)]*)\)\s*(.*)$/i.exec(s);
  if (m) {
    return (m[1] ? 'CONSTRAINT ' + qpg(m[1]) + ' ' : '')
      + 'FOREIGN KEY (' + colList(m[2]).map(qpg).join(', ') + ')'
      + ' REFERENCES ' + qpg(m[3]) + ' (' + colList(m[4]).map(qpg).join(', ') + ')'
      + (m[5] ? ' ' + m[5].trim().replace(/\s+/g, ' ').toUpperCase() : '');
  }
  m = /^(?:CONSTRAINT\s+(\S+)\s+)?UNIQUE\s*\(([^)]*)\)\s*$/i.exec(s);
  if (m) return (m[1] ? 'CONSTRAINT ' + qpg(m[1]) + ' ' : '') + 'UNIQUE (' + colList(m[2]).map(qpg).join(', ') + ')';
  return s;
}

// 整张表 → PG 建表语句。没有 ENGINE / CHARSET 尾巴（PG 全库一个编码，建库时定）。
// ⚠️ DROP 必须带 CASCADE：PG 没有「关闭外键检查」的会话开关
//    （session_replication_role 要超级用户），不带 CASCADE 就连一张被子表引用着的
//    父表都拆不掉 —— 而我们的建表顺序恰好是父表在前。代价是目标库里若有**别的**表
//    引用这些表，它们的相关约束会被一并删掉，所以导入请用空库（文件头也写了）。
function pgTable(def) {
  const lines = def.cols.map((c) => '  ' + qpg(c.name) + ' ' + pgColumn(c));
  for (const e of def.extras) lines.push('  ' + pgConstraint(e));
  for (const f of def.fks) {
    lines.push('  FOREIGN KEY (' + qpg(f.col) + ') REFERENCES ' + qpg(f.ref)
      + ' (' + f.refCols.map(qpg).join(', ') + ')' + (f.onDelete ? ' ' + f.onDelete : ''));
  }
  return 'DROP TABLE IF EXISTS ' + qpg(def.name) + ' CASCADE;\n'
    + 'CREATE TABLE ' + qpg(def.name) + ' (\n' + lines.join(',\n') + '\n);';
}

function pgIndex(ix) {
  // PG 的索引列也支持后跟 DESC，原样保留
  return 'CREATE ' + (ix.unique ? 'UNIQUE ' : '') + 'INDEX ' + qpg(ix.name) + ' ON ' + qpg(ix.table)
    + ' (' + ix.cols.map((c) => qpg(c.col) + (c.dir ? ' ' + c.dir : '')).join(', ') + ');';
}

// ★★ PG 独有的收尾：重设自增序列。
//    前面所有 INSERT 都把 id 原样写了进去，而 PG 的序列（IDENTITY / SERIAL）**不会**
//    因此前进 —— 导完库以后第一条不指定 id 的 INSERT 会直接主键冲突。
//    SQLite 有 sqlite_sequence 会自动跟上、MySQL 的 AUTO_INCREMENT 在插入显式值时
//    也会自动抬高，所以**只有 PG 需要这一步**。
//
//    第三个参数 is_called 决定下一次 nextval 从哪儿开始：
//      · 表里有数据 → setval(seq, MAX(id))，is_called 默认 true → 下一条取 MAX(id)+1 ✓
//      · 表是空的   → GREATEST 兜到 1，is_called = (0 > 0) = false → 下一条取 1 ✓
//    一条语句同时管住这两种情况，不必分支。
function setvalStatement(table, col) {
  const tq = qpg(table);
  const cq = qpg(col);
  // pg_get_serial_sequence 的两个参数都是**字符串**（内部按标识符解析），
  // 所以表名要再包一层单引号；引号里的 "posts" 正好被解析成大小写敏感匹配的 posts。
  return 'SELECT setval(pg_get_serial_sequence(' + "'" + tq + "', '" + col + "'),\n"
    + '              GREATEST(COALESCE((SELECT MAX(' + cq + ') FROM ' + tq + '), 0), 1),\n'
    + '              (SELECT COUNT(*) FROM ' + tq + ') > 0);';
}

// ============ 字面量 ============

// 导出的（targets.js 复用）：标量 → 方言安全的 SQL 字面量。
// 全项目只此一份 —— 别处再抄一个 `'` → `''` 的替换，迟早抄漏某种方言。
export function literal(v, dialect) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  // BLOB 兜底：本项目 schema 里没有 BLOB 列，但 D1 真返回二进制时不能吐成乱码
  if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) {
    const u8 = v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    let hex = '';
    for (const b of u8) hex += b.toString(16).padStart(2, '0');
    // PG 没有 X'..' 这种十六进制字面量（那是 MySQL/SQLite 的写法），走 decode()。
    // 刻意不用 E'\x..' —— 那等于再回到「反斜杠到底该写几个」的坑里，decode 干净利落。
    if (dialect === 'pg') return "decode('" + hex + "','hex')";
    return "X'" + hex + "'";
  }
  let s = String(v);
  if (dialect === 'mysql') {
    // ⚠️ MySQL 默认把反斜杠当转义符（SQLite 不认）：
    //    正文里出现 `\n`（字面的反斜杠 + n）时，不双写就会被 MySQL 吃成一个真换行，
    //    `\x` 更会直接报语法错。所以反斜杠必须先双写。
    //    单引号两边的写法用 `''`（三种方言都认），不用 `\'`。
    s = s.replace(/\\/g, '\\\\').replace(/\0/g, '\\0').replace(/\x1a/g, '\\Z');
  }
  // ⚠️ pg：反斜杠**不能**双写，规则跟 MySQL 正好相反。
  //    从 PG 9.1 起 standard_conforming_strings 默认为 on，反斜杠就是普通字符；
  //    双写了反而会在数据里凭空多出一个反斜杠。头部另有一行显式
  //    `SET standard_conforming_strings = on;` 把它钉死，免得撞上关掉该参数的老配置。
  return "'" + s.replace(/'/g, "''") + "'";
}

// ============ 组装 ============

// 单条 INSERT 的规模。既防「Statement too long」（D1 官方明确提过这条），
// 也防 MySQL 的 max_allowed_packet；正文列动辄几十 KB，所以行数与字节数双限。
const CHUNK_ROWS = 32;
const CHUNK_BYTES = 256 * 1024;

// 导出的（targets.js 复用）：把一组行渲染成 INSERT。
// cols 是列名数组（顺序决定 INSERT 的列序），rows 是等长的普通对象数组。
export function insertStatements(table, cols, rows, dialect) {
  const qi = (n) => quoteIdent(dialect, n);   // INSERT 里的标识符也跟着方言换引号
  const out = [];
  let buf = [];
  let bytes = 0;
  const flush = () => {
    if (!buf.length) return;
    out.push('INSERT INTO ' + qi(table) + ' (' + cols.map(qi).join(', ') + ') VALUES\n  '
      + buf.join(',\n  ') + ';');
    buf = [];
    bytes = 0;
  };
  for (const r of rows) {
    const tup = '(' + cols.map((c) => literal(r[c], dialect)).join(', ') + ')';
    bytes += tup.length;
    buf.push(tup);
    if (buf.length >= CHUNK_ROWS || bytes >= CHUNK_BYTES) flush();
  }
  flush();
  return out;
}

// 按外键依赖做拓扑排序：被引用的表先写，导入时不会撞上「引用的表还不存在」。
// 同层按表名排序，保证每次导出的顺序完全一致（便于 diff）。
function topoOrder(deps) {
  const names = [...deps.keys()].sort();
  const out = [];
  const done = new Set();
  const cycle = new Set(names);
  let guard = names.length + 1;
  while (out.length < names.length && guard-- > 0) {
    const ready = names.filter((n) => !done.has(n)
      && [...deps.get(n)].every((d) => d === n || !deps.has(d) || done.has(d)));
    if (!ready.length) break;          // 有环：剩下的按表名补在最后，不卡死
    for (const n of ready) { done.add(n); out.push(n); }
  }
  for (const n of names) if (!done.has(n) && cycle.has(n)) out.push(n);
  return out;
}

/**
 * 导出整库为 SQL 文本。
 * @param {object} db       D1 绑定（只需 prepare(sql).all()）
 * @param {'sqlite'|'mysql'|'pg'} dialect  也接受 postgres / postgresql / pgsql 这几种写法
 * @param {string} nowText  导出时间文本（由调用方传 bnNow()，方便测试固定）
 */
export async function dumpSql(db, dialect = 'sqlite', nowText = '') {
  const all = async (sql) => { try { return ((await db.prepare(sql).all()).results) || []; } catch (e) { return []; } };
  const fmt = normalizeFmt(dialect);
  const isMy = fmt === 'mysql';
  const isPg = fmt === 'pg';

  const objects = await all("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name");
  const tableRows = objects.filter((o) => o.type === 'table' && !SKIP_TABLE(o.name));
  const indexRows = objects.filter((o) => o.type === 'index' && !SKIP_TABLE(o.tbl_name));

  const defs = new Map();
  const skipped = [];
  for (const t of tableRows) {
    const def = parseTable(t.sql);
    if (def) defs.set(def.name, def); else skipped.push(t.name);
  }

  // 索引原文 → 解析结果，并按表登记「参与索引的列」
  const indexes = [];
  const ixByTable = new Map();
  for (const i of indexRows) {
    const ix = parseIndex(i.sql);
    if (!ix) { skipped.push(i.name); continue; }
    indexes.push(ix);
    if (!ixByTable.has(ix.table)) ixByTable.set(ix.table, []);
    ixByTable.get(ix.table).push(ix);
  }

  // 某表里哪些列「参与索引」（主键 / 内联 UNIQUE / 独立索引都算）
  const indexedOf = (def) => {
    const s = new Set(def.pkCols);
    for (const c of def.cols) if (c.isUq) s.add(c.name);
    for (const ix of (ixByTable.get(def.name) || [])) for (const c of ix.cols) s.add(c.col);
    return s;
  };

  // 外键依赖 → 拓扑序（列内联与表级 FOREIGN KEY 都算，见 parseTable 的 refs）
  const deps = new Map();
  for (const [n, d] of defs) deps.set(n, new Set(d.refs.filter((r) => defs.has(r))));
  const order = topoOrder(deps);

  // 取数据：列名从 DDL 里拿（列顺序 = 表声明顺序），不依赖 PRAGMA
  const data = new Map();
  const counts = new Map();
  let total = 0;
  for (const n of order) {
    const rows = await all('SELECT * FROM ' + q(n));
    data.set(n, rows);
    counts.set(n, rows.length);
    total += rows.length;
  }

  const head = [];
  head.push('-- 云尚博客 · 数据库导出（' + (isPg ? 'PostgreSQL' : isMy ? 'MySQL' : 'SQLite') + '）');
  head.push('-- 导出时间：' + (nowText || ''));
  head.push('-- 表 ' + order.length + ' 张 / 记录 ' + total + ' 条');
  head.push('--');
  head.push('-- ⚠️ 本文件是明文全量数据，settings 表里有 SMTP 授权码、AUTH_SECRET、API Token 等站点密钥，');
  head.push('--    请当敏感文件保管，不要放到公开可访问的地方。');
  head.push('-- ⚠️ 每张表前面带 DROP TABLE IF EXISTS，导入会**覆盖**目标库里的同名表。');
  if (!isMy && !isPg) {
    head.push('-- ⚠️ 若要喂给 `wrangler d1 execute --file`，官方要求把下面的 BEGIN TRANSACTION / COMMIT 两行删掉。');
  }
  if (isPg) {
    head.push('-- ⚠️ PG 没有「关闭外键检查」的会话开关，所以 DROP 带了 CASCADE —— 目标库里若有别的');
    head.push('--    表引用这些表，它们的相关约束会被一并删掉。导入请用**空库**。');
    head.push('-- ✔ 文件末尾按表补了 setval 重设自增序列：PG 的序列不会因为上面显式插入了 id 而前进，');
    head.push('--    不补的话，导入后第一条不指定 id 的 INSERT 会直接主键冲突。');
  }
  if (skipped.length) head.push('-- ⚠️ 以下对象没能解析、已跳过：' + skipped.join(', '));
  head.push('--');
  head.push('-- 表（按外键依赖排序，被引用的在前）：');
  for (const n of order) head.push('--   ' + n + '  (' + counts.get(n) + ' 条)');
  head.push('');

  const body = [];
  if (isMy) {
    body.push('SET NAMES utf8mb4;');
    body.push('SET FOREIGN_KEY_CHECKS=0;');   // 免得表/行的顺序把导入卡死
  } else if (isPg) {
    body.push("SET client_encoding = 'UTF8';");
    // 这两项从 PG 9.1 起本来就默认是 on，显式写死是为了不撞上被改过的老配置 ——
    // literal() 生成的字符串按「反斜杠就是普通字符」来写，这两行是它的前提。
    body.push('SET standard_conforming_strings = on;');
  } else {
    body.push('PRAGMA foreign_keys=OFF;');
  }
  body.push('');
  body.push('BEGIN TRANSACTION;');
  body.push('');

  const deferred = [];   // 索引建表之后再加，导入更快
  const seqs = [];       // PG：需要重设序列的自增表（见 setvalStatement）
  for (const n of order) {
    const def = defs.get(n);
    const cols = def.cols.map((c) => c.name);
    if (isPg) {
      // PG：DROP(... CASCADE) 与 CREATE 一起封在 pgTable 里，形态跟 mysqlTable 一致
      body.push(pgTable(def));
    } else if (isMy) {
      body.push(mysqlTable(def, indexedOf(def)));
    } else {
      // SQLite：建表原文照抄（sqlite_master 存的已经把 IF NOT EXISTS 抹掉了，
      // 无所谓 —— 上一行的 DROP TABLE IF EXISTS 已经保证可重复导入）
      body.push('DROP TABLE IF EXISTS ' + q(n) + ';');
      body.push(def.raw + ';');
    }
    body.push('');
    for (const st of insertStatements(n, cols, data.get(n) || [], fmt)) { body.push(st); body.push(''); }
    for (const ix of (ixByTable.get(n) || [])) {
      deferred.push(isMy ? mysqlIndex(ix) : isPg ? pgIndex(ix) : ix.raw + ';');
    }
    // 自增列就是 PK，记下来待会儿补 setval
    if (isPg && def.cols.some((c) => /\bAUTOINCREMENT\b/i.test(c.rest))) {
      seqs.push({ table: n, col: def.pkCols[0] || 'id' });
    }
  }

  // ★ 只有 PG 需要：把每张自增表的序列拨到当前最大 id
  if (seqs.length) {
    body.push('-- 重设自增序列（PG 独有的一步）：序列不会因为上面显式插入了 id 而前进，');
    body.push('-- 不补的话，导入后第一条不指定 id 的 INSERT 就会撞主键。');
    for (const s of seqs) body.push(setvalStatement(s.table, s.col));
    body.push('');
  }

  if (deferred.length) {
    body.push('-- 索引（放在数据之后一次建好）');
    for (const st of deferred) body.push(st);
    body.push('');
  }
  body.push('COMMIT;');
  if (isMy) { body.push(''); body.push('SET FOREIGN_KEY_CHECKS=1;'); }
  body.push('');

  return head.join('\n') + '\n' + body.join('\n');
}

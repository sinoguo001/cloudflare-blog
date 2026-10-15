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
// 3. 两种方言共用同一份数据，只有 DDL 与字面量转义走不同分支。
//    - sqlite：DDL 原样照抄，字符串只需把 `'` 写成 `''`。
//    - mysql ：必须翻译，差别都在 mysqlType()/约束改写里，逐条有注释。
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

// 反引号包裹标识符。本项目实测有 12 个列名撞上 MySQL 的保留字/关键字
// （key / status / type / sort / source / day / password / link / name / url / value / ok），
// 不包反引号 MySQL 直接语法错误，所以**一律全包**，不挑。
const q = (id) => '`' + String(id).replace(/`/g, '``') + '`';

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
  for (const part of splitTop(m[2])) {
    if (/^(?:CONSTRAINT\s+\S+\s+)?(?:PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK)\b/i.test(part)) {
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
function parseIndex(ddl) {
  const raw = String(ddl).trim();
  const m = /^\s*CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"[]?([\w$]+)[`"\]]?\s+ON\s+[`"[]?([\w$]+)[`"\]]?\s*\(([\s\S]*)\)\s*$/i.exec(raw);
  if (!m) return null;
  return { unique: !!m[1], name: m[2], table: m[3], raw, cols: colListWithDir(m[4]) };
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

// ============ 字面量 ============

function literal(v, dialect) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  // BLOB 兜底：本项目 schema 里没有 BLOB 列，但 D1 真返回二进制时不能吐成乱码
  if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) {
    const u8 = v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    let hex = '';
    for (const b of u8) hex += b.toString(16).padStart(2, '0');
    return "X'" + hex + "'";
  }
  let s = String(v);
  if (dialect === 'mysql') {
    // ⚠️ MySQL 默认把反斜杠当转义符（SQLite 不认）：
    //    正文里出现 `\n`（字面的反斜杠 + n）时，不双写就会被 MySQL 吃成一个真换行，
    //    `\x` 更会直接报语法错。所以反斜杠必须先双写。
    //    单引号两边的写法用 `''`（两种方言都认），不用 `\'`。
    s = s.replace(/\\/g, '\\\\').replace(/\0/g, '\\0').replace(/\x1a/g, '\\Z');
  }
  return "'" + s.replace(/'/g, "''") + "'";
}

// ============ 组装 ============

// 单条 INSERT 的规模。既防「Statement too long」（D1 官方明确提过这条），
// 也防 MySQL 的 max_allowed_packet；正文列动辄几十 KB，所以行数与字节数双限。
const CHUNK_ROWS = 32;
const CHUNK_BYTES = 256 * 1024;

function insertStatements(table, cols, rows, dialect) {
  const out = [];
  let buf = [];
  let bytes = 0;
  const flush = () => {
    if (!buf.length) return;
    out.push('INSERT INTO ' + q(table) + ' (' + cols.map(q).join(', ') + ') VALUES\n  '
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
 * @param {'sqlite'|'mysql'} dialect
 * @param {string} nowText  导出时间文本（由调用方传 bnNow()，方便测试固定）
 */
export async function dumpSql(db, dialect = 'sqlite', nowText = '') {
  const all = async (sql) => { try { return ((await db.prepare(sql).all()).results) || []; } catch (e) { return []; } };
  const isMy = dialect === 'mysql';

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
  head.push('-- 云尚博客 · 数据库导出（' + (isMy ? 'MySQL' : 'SQLite') + '）');
  head.push('-- 导出时间：' + (nowText || ''));
  head.push('-- 表 ' + order.length + ' 张 / 记录 ' + total + ' 条');
  head.push('--');
  head.push('-- ⚠️ 本文件是明文全量数据，settings 表里有 SMTP 授权码、AUTH_SECRET、API Token 等站点密钥，');
  head.push('--    请当敏感文件保管，不要放到公开可访问的地方。');
  head.push('-- ⚠️ 每张表前面带 DROP TABLE IF EXISTS，导入会**覆盖**目标库里的同名表。');
  if (!isMy) {
    head.push('-- ⚠️ 若要喂给 `wrangler d1 execute --file`，官方要求把下面的 BEGIN TRANSACTION / COMMIT 两行删掉。');
  }
  if (skipped.length) head.push('-- ⚠️ 以下对象没能解析、已跳过：' + skipped.join(', '));
  head.push('--');
  head.push('-- 表（按外键依赖排序，被引用的在前）：');
  for (const n of order) head.push('--   ' + n + '  (' + counts.get(n) + ' 条)');
  head.push('');

  const body = [];
  body.push(isMy ? 'SET NAMES utf8mb4;' : 'PRAGMA foreign_keys=OFF;');
  if (isMy) body.push('SET FOREIGN_KEY_CHECKS=0;');   // 免得表/行的顺序把导入卡死
  body.push('');
  body.push('BEGIN TRANSACTION;');
  body.push('');

  const deferred = [];   // 索引建表之后再加，导入更快
  for (const n of order) {
    const def = defs.get(n);
    const cols = def.cols.map((c) => c.name);
    if (isMy) {
      body.push(mysqlTable(def, indexedOf(def)));
    } else {
      // SQLite：建表原文照抄（sqlite_master 存的已经把 IF NOT EXISTS 抹掉了，
      // 无所谓 —— 上一行的 DROP TABLE IF EXISTS 已经保证可重复导入）
      body.push('DROP TABLE IF EXISTS ' + q(n) + ';');
      body.push(def.raw + ';');
    }
    body.push('');
    for (const st of insertStatements(n, cols, data.get(n) || [], dialect)) { body.push(st); body.push(''); }
    for (const ix of (ixByTable.get(n) || [])) {
      deferred.push(isMy ? mysqlIndex(ix) : ix.raw + ';');
    }
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

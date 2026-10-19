// ============================================================
// SQL 转储解析器（Ver 0.7 ① 数据导入）
//
// 只干三件事：判断这份 .sql 是什么方言、有哪些表、每张表有哪些行。
// DDL 里的类型、约束、索引一概不管 —— 导入只按「列名 → 值」搬数据。
//
// 为什么放在浏览器端执行：Workers 免费版单请求 CPU 只有约 10ms，
// 几 MB 的 SQL 在服务端逐字符扫描必然 1102 超时。解析完只把规整后的
// 行分批 POST 回去写库，服务端的工作量与文件大小无关。
//
// 纯函数、零依赖，浏览器与 Node 都能直接 import（测试就这么用）。
// ============================================================

const SPECIAL = new Set(["'", '"', '`', ';', '$']);

export function stripBom(s) {
  return String(s || '').replace(/^\uFEFF/, '');
}

function isWs(c) {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r';
}

function skipWs(s, i) {
  while (i < s.length && isWs(s[i])) i++;
  return i;
}

// `--` 注释、`#` 注释（MySQL）、`/* */` 块注释。
// `--` 必须处在行首或空白之后，避免把 a--b 这种减号当注释。
function isCommentAt(s, k) {
  const c = s[k];
  const prev = s[k - 1];
  const atStart = prev === undefined || prev === ' ' || prev === '\n' || prev === '\r' || prev === '\t';
  if (c === '-' && s[k + 1] === '-') return atStart;
  if (c === '#' && atStart) return true;
  if (c === '/' && s[k + 1] === '*') return true;
  return false;
}

// 读一个带引号的片段（含两端引号），返回结束位置。
// 同时处理两种转义：SQL 标准的双写（'' 或 ""）与反斜杠（MySQL 大量使用）。
function readQuoted(s, i) {
  const q = s[i];
  const n = s.length;
  let j = i + 1;
  while (j < n) {
    const c = s[j];
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === q) {
      if (s[j + 1] === q) {
        j += 2;
        continue;
      }
      return j + 1;
    }
    j++;
  }
  return n;
}

// PG 的 $tag$ ... $tag$（函数体里才常见，但不处理会把整段切错）
function readDollar(s, i) {
  const m = /^\$([A-Za-z_][A-Za-z0-9_]{0,60})?\$/.exec(s.slice(i, i + 66));
  if (!m) return i;
  const tag = m[0];
  const e = s.indexOf(tag, i + tag.length);
  return e < 0 ? s.length : e + tag.length;
}

// COPY ... FROM stdin; 之后是裸数据行，直到单独一行 `\.`
function readCopyBlock(src, i) {
  const lines = [];
  const n = src.length;
  let p = i;
  while (p < n) {
    let e = src.indexOf('\n', p);
    if (e < 0) e = n;
    const line = src.slice(p, e).replace(/\r$/, '');
    p = e < n ? e + 1 : n;
    if (line === '\\.') break;
    lines.push(line);
  }
  return { lines, next: p };
}

// 把整份文件切成语句；COPY 数据块单独成段。
export function splitSql(text) {
  const src = stripBom(text);
  const n = src.length;
  const out = [];
  const parts = [];
  let i = 0;

  const pushStmt = (endPos) => {
    const sql = parts.join('').trim();
    parts.length = 0;
    if (!sql) return endPos;
    if (/\bCOPY\b[\s\S]*\bFROM\s+stdin\b/i.test(sql)) {
      const blk = readCopyBlock(src, endPos);
      out.push({ kind: 'copy', sql, lines: blk.lines });
      return blk.next;
    }
    out.push({ kind: 'stmt', sql });
    return endPos;
  };

  while (i < n) {
    // 快进：整段普通字符一次吞掉，避免逐字符 push（大文件差几十倍）
    let j = i;
    while (j < n) {
      const d = src[j];
      if (SPECIAL.has(d) || isCommentAt(src, j)) break;
      j++;
    }
    if (j > i) {
      parts.push(src.slice(i, j));
      i = j;
      if (i >= n) break;
    }

    const c = src[i];
    if (isCommentAt(src, i)) {
      if (c === '/') {
        const e = src.indexOf('*/', i + 2);
        i = e < 0 ? n : e + 2;
      } else {
        const e = src.indexOf('\n', i);
        i = e < 0 ? n : e + 1;
      }
      parts.push(' ');
      continue;
    }
    if (c === ';') {
      i = pushStmt(i + 1);
      continue;
    }
    if (c === '$') {
      const k = readDollar(src, i);
      if (k > i) {
        parts.push(src.slice(i, k));
        i = k;
        continue;
      }
      parts.push(c);
      i++;
      continue;
    }
    const k = readQuoted(src, i);
    parts.push(src.slice(i, k));
    i = k;
  }
  pushStmt(i);
  return out;
}

// ---------- 小工具 ----------

function unquoteIdent(v) {
  const s = String(v || '').trim();
  if (s.length >= 2) {
    const a = s[0];
    if ((a === '"' && s[s.length - 1] === '"') || (a === '`' && s[s.length - 1] === '`') || (a === '[' && s[s.length - 1] === ']')) {
      return s.slice(1, -1);
    }
  }
  return s;
}

function shortName(name) {
  return unquoteIdent(String(name || '').split('.').pop());
}

function matchParen(s, i) {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === "'" || c === '"' || c === '`') {
      j = readQuoted(s, j) - 1;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}

// 顶层逗号切分（引号与括号内的逗号不算）
export function splitTop(s, sep) {
  const out = [];
  let cur = '';
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'" || c === '"' || c === '`') {
      const j = readQuoted(s, i);
      cur += s.slice(i, j);
      i = j - 1;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    if (c === sep && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

function unescapeStr(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) {
      const d = s[++i];
      const map = { n: '\n', r: '\r', t: '\t', '0': '\0', b: '\b', Z: '\x1a', f: '\f', v: '\v' };
      out += map[d] !== undefined ? map[d] : d;
      continue;
    }
    if ((c === "'" || c === '"') && s[i + 1] === c) {
      out += c;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

function unescapeCopy(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) {
      const d = s[++i];
      const map = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v' };
      out += map[d] !== undefined ? map[d] : d;
      continue;
    }
    out += c;
  }
  return out;
}

// 把一个 SQL 字面量还原成 JS 值。
// 宁可把认不出的东西原样留下，也不猜 —— 猜错会把正文写成乱七八糟的东西。
export function parseValue(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  const q = s[0];
  if (q === "'" || q === '"' || q === '`') {
    if (s.length >= 2 && s[s.length - 1] === q) return unescapeStr(s.slice(1, -1));
  }
  if (/^[EeNn]?'/.test(s)) {
    const body = s.replace(/^[Ee]/, '');
    if (body.length >= 2 && body[body.length - 1] === "'") return unescapeStr(body.slice(1, -1));
  }
  // PG 的类型转换后缀：NULL::character varying、'x'::text、123::bigint
  s = s.replace(/::[\w\s.]+(?:\([^)]*\))?/g, '').trim();
  if (/^null$/i.test(s)) return null;
  if (/^true$/i.test(s)) return 1;
  if (/^false$/i.test(s)) return 0;
  if (/^-?\d+$/.test(s)) {
    const v = Number(s);
    return Number.isSafeInteger(v) ? v : s;
  }
  if (/^-?\d*\.\d+(?:[eE][+-]?\d+)?$/.test(s)) return Number(s);
  const hex = /^0x([0-9a-f]+)$/i.exec(s);
  if (hex) return hex[1];
  return s;
}

// ---------- 语句解析 ----------

export function parseCreateColumns(sql) {
  const m = /\bCREATE\s+TABLE\b[\s\S]*?\(/.exec(sql);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  const end = matchParen(sql, open);
  if (end < 0) return null;
  const defs = splitTop(sql.slice(open + 1, end), ',');
  const cols = [];
  for (const def of defs) {
    const t = def.trim();
    if (!t) continue;
    // 表级约束不是列
    if (/^(PRIMARY|UNIQUE|KEY|INDEX|CONSTRAINT|FOREIGN|CHECK|EXCLUDE|FULLTEXT|SPATIAL)\b/i.test(t)) continue;
    const cm = /^(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][\w$]*))/.exec(t);
    if (cm) cols.push(cm[1] || cm[2] || cm[3] || cm[4]);
  }
  return cols.length ? cols : null;
}

export function parseCreateTableName(sql) {
  const m = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s(]+)/i.exec(sql);
  return m ? shortName(m[1]) : '';
}

function readIdent(s, i) {
  let out = '';
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (isWs(c) || c === '(') break;
    if (c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      const j = s.indexOf(close, i + 1);
      const e = j < 0 ? n : j + 1;
      out += s.slice(i + 1, e - 1);
      i = e;
      continue;
    }
    out += c;
    i++;
  }
  return { name: out, end: i };
}

function parseTuples(s) {
  const rows = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    while (i < n && s[i] !== '(') i++;
    if (i >= n) break;
    i++;
    const row = [];
    let cur = '';
    let depth = 1;
    while (i < n) {
      const c = s[i];
      if (c === "'" || c === '"' || c === '`') {
        const j = readQuoted(s, i);
        cur += s.slice(i, j);
        i = j;
        continue;
      }
      if (c === '(') {
        depth++;
        cur += c;
        i++;
        continue;
      }
      if (c === ')') {
        depth--;
        if (depth === 0) {
          row.push(parseValue(cur));
          i++;
          break;
        }
        cur += c;
        i++;
        continue;
      }
      if (c === ',' && depth === 1) {
        row.push(parseValue(cur));
        cur = '';
        i++;
        continue;
      }
      cur += c;
      i++;
    }
    if (row.length) rows.push(row);
  }
  return rows;
}

export function parseInsert(sql) {
  const s = String(sql || '').trim().replace(/;$/, '');
  if (!/^(INSERT|REPLACE)\b/i.test(s)) return null;
  const im = /\bINTO\b/i.exec(s);
  if (!im) return null;
  let i = skipWs(s, im.index + im[0].length);
  const id = readIdent(s, i);
  if (!id.name) return null;
  i = skipWs(s, id.end);
  let cols = null;
  if (s[i] === '(') {
    const e = matchParen(s, i);
    if (e < 0) return null;
    cols = splitTop(s.slice(i + 1, e), ',').map((c) => unquoteIdent(c)).filter(Boolean);
    i = skipWs(s, e + 1);
  }
  const vm = /^VALUES?\b/i.exec(s.slice(i));
  if (!vm) return null;
  i += vm[0].length;
  const rows = parseTuples(s.slice(i));
  return { table: shortName(id.name), cols: cols && cols.length ? cols : null, rows };
}

export function parseCopy(sql, lines) {
  const m = /\bCOPY\b\s+([^\s(]+)\s*(?:\(([^)]*)\))?\s+FROM\s+stdin/i.exec(String(sql || ''));
  if (!m) return null;
  const cols = m[2] ? splitTop(m[2], ',').map((c) => unquoteIdent(c)).filter(Boolean) : null;
  const rows = [];
  for (const line of lines || []) {
    if (line === '') continue;
    rows.push(line.split('\t').map((c) => (c === '\\N' ? null : unescapeCopy(c))));
  }
  return { table: shortName(m[1]), cols: cols && cols.length ? cols : null, rows };
}

// ---------- 汇总成表模型 ----------

export function readDump(text) {
  const tokens = splitSql(text);
  const tables = new Map();
  const warnings = [];
  let statements = 0;

  const ensure = (name) => {
    if (!tables.has(name)) tables.set(name, { name, cols: null, ddlCols: null, rows: [], skipped: 0 });
    return tables.get(name);
  };

  for (const tk of tokens) {
    if (tk.kind === 'copy') {
      statements++;
      const p = parseCopy(tk.sql, tk.lines);
      if (!p) continue;
      const t = ensure(p.table);
      if (p.cols) setCols(t, p.cols);
      t.rows.push(...p.rows);
      continue;
    }
    const sql = tk.sql;
    if (/^\s*CREATE\s+TABLE/i.test(sql)) {
      statements++;
      const name = parseCreateTableName(sql);
      if (name) ensure(name).ddlCols = parseCreateColumns(sql);
      continue;
    }
    if (/\b(INSERT|REPLACE)\b/i.test(sql)) {
      statements++;
      const p = parseInsert(sql);
      if (!p) {
        warnings.push('有一段 INSERT 没能解析，已跳过：' + sql.slice(0, 80).replace(/\s+/g, ' '));
        continue;
      }
      const t = ensure(p.table);
      if (p.cols) setCols(t, p.cols);
      else if (!t.cols && t.ddlCols) t.cols = t.ddlCols;
      if (!t.cols) {
        t.skipped += p.rows.length;
        continue;
      }
      // 行宽对不上就整行丢弃：宁可少导，也不要把内容错位塞进别的列
      for (const r of p.rows) {
        if (r.length === t.cols.length) t.rows.push(r);
        else t.skipped++;
      }
    }
  }

  for (const t of tables.values()) {
    if (!t.cols && t.ddlCols) t.cols = t.ddlCols;
    if (t.skipped) warnings.push(`表 ${t.name} 有 ${t.skipped} 行的列数与表结构对不上，已跳过`);
  }

  return {
    tokens: tokens.length,
    statements,
    tables,
    dialect: detectDialect(text, tables),
    program: detectProgram(tables),
    warnings,
  };
}

function setCols(t, cols) {
  if (!t.cols) t.cols = cols;
  else if (t.cols.length !== cols.length) t.cols = cols;
}

// ---------- 方言识别 ----------

export function detectDialect(text, tables) {
  const src = String(text || '');
  let pg = 0, my = 0, lite = 0;

  if (/\bCOPY\b[\s\S]*?\bFROM\s+stdin\b/i.test(src)) pg += 6;
  if (/pg_catalog\.setval|\bnextval\s*\(/i.test(src)) pg += 4;
  if (/\bGENERATED\s+(?:ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY\b/i.test(src)) pg += 4;
  if (/::(?:character varying|text|integer|bigint|boolean)\b/i.test(src)) pg += 3;
  if (/\bSET\s+statement_timeout\b|\bOWNER\s+TO\b|\bsearch_path\b/i.test(src)) pg += 2;

  if (/\bAUTO_INCREMENT\b/i.test(src)) my += 5;
  if (/`[^`]+`/.test(src)) my += 3;
  if (/\bENGINE\s*=\s*\w+/i.test(src)) my += 4;
  if (/\/\*!\d{5}/.test(src)) my += 3;
  if (/\bLOCK\s+TABLES\b|\bUNLOCK\s+TABLES\b/i.test(src)) my += 2;
  if (/\bSET\s+NAMES\b/i.test(src)) my += 2;

  if (/\bPRAGMA\b/i.test(src)) lite += 4;
  if (/\bsqlite_sequence\b/i.test(src)) lite += 4;
  if (/\bAUTOINCREMENT\b/i.test(src)) lite += 4;
  if (/\bBEGIN\s+TRANSACTION\b/i.test(src) && my === 0 && pg === 0) lite += 1;

  for (const t of tables.values()) {
    if (t.cols && t.cols.includes('sqlite_sequence')) lite++;
  }

  const best = Math.max(pg, my, lite);
  if (best === 0) return 'sqlite';
  if (pg === best) return 'pg';
  if (my === best) return 'mysql';
  return 'sqlite';
}

export const DIALECT_LABEL = { sqlite: 'SQLite', mysql: 'MySQL', pg: 'PostgreSQL' };

// ---------- 来源程序识别 ----------

function findTable(tables, suffix) {
  for (const [name, t] of tables) {
    if (name === suffix || name.endsWith('_' + suffix)) {
      return { name, t, prefix: name === suffix ? '' : name.slice(0, name.length - suffix.length) };
    }
  }
  return null;
}

function hasCols(t, cols) {
  if (!t || !t.cols) return false;
  // 列名大小写不能当真：pg_dump 建的 Z-Blog 表全是小写（log_id），
  // WP 的 ID 又是大写。比较一律折成小写。
  const lower = t.cols.map((c) => String(c).toLowerCase());
  return cols.every((c) => lower.includes(String(c).toLowerCase()));
}

export function detectProgram(tables) {
  const wpPosts = findTable(tables, 'posts');
  const wpOptions = findTable(tables, 'options');
  if (wpPosts && hasCols(wpPosts.t, ['post_content'])) {
    const strong = hasCols(wpPosts.t, ['post_type', 'post_status']) || !!findTable(tables, 'term_taxonomy');
    if (strong) return { key: 'wordpress', name: 'WordPress', prefix: wpPosts.prefix, evidence: wpPosts.name + ' 表含 post_content / post_type' };
  }

  const tcContents = findTable(tables, 'contents');
  if (tcContents && hasCols(tcContents.t, ['cid', 'text'])) {
    return { key: 'typecho', name: 'Typecho', prefix: tcContents.prefix, evidence: tcContents.name + ' 表含 cid / text' };
  }

  const zbPost = findTable(tables, 'post');
  if (zbPost && hasCols(zbPost.t, ['log_ID', 'log_Content'])) {
    return { key: 'zblog', name: 'Z-BlogPHP', prefix: zbPost.prefix, evidence: zbPost.name + ' 表含 log_ID / log_Content' };
  }

  // 兜底：只有 posts 表也认成 WordPress（很多导出器只导这一张）
  if (wpPosts && wpOptions) {
    return { key: 'wordpress', name: 'WordPress', prefix: wpPosts.prefix, evidence: 'posts + options 表结构' };
  }
  return { key: '', name: '无法识别', prefix: '', evidence: '没找到任何一家的标志性表名' };
}

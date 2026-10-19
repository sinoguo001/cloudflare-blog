// ============================================================
// 导入写库（Ver 0.7 ①）
//
// 浏览器端已经算好「要写哪些行、每行的 id 是多少」，这里只做三件事：
//   ① 白名单校验 —— 只认这五张表、这些列，别的一律拒绝；
//   ② 补 content_html —— Markdown 来源的行没有 HTML，用本站渲染器补；
//   ③ 批量写入 —— 每批一个 batch（原子），失败时按 id 区间回滚。
//
// 为什么 id 由前端给：重编号需要全局映射（分类 → 文章 → 评论的引用链），
// 而这个映射在浏览器里算完才可能一次算对；服务端只验「是不是正整数」。
// 接口只对已登录的管理员开放，最坏情况是管理员把自己的库写乱，不涉及越权。
// ============================================================

import { render as renderMd } from './md.js';

// 只允许写这几张表；列也必须逐个点名，防止前端塞进 settings / users 之类
const TABLES = {
  categories: ['id', 'name', 'slug', 'description', 'created_at', 'parent_id', 'in_nav'],
  tags: ['id', 'name', 'slug', 'created_at'],
  posts: ['id', 'title', 'slug', 'excerpt', 'content_md', 'content_html', 'cover_key', 'status',
    'category_id', 'view_count', 'created_at', 'updated_at', 'published_at', 'type', 'in_nav', 'password', 'pin'],
  post_tags: ['post_id', 'tag_id'],
  comments: ['id', 'post_id', 'parent_id', 'author', 'email', 'website', 'content', 'status',
    'is_admin', 'ip', 'created_at'],
};

export const IMPORT_TABLES = Object.keys(TABLES);

const MAX_ROWS_PER_BATCH = 200;

const REQUIRED = {
  categories: ['id', 'name', 'slug'],
  tags: ['id', 'name', 'slug'],
  posts: ['id', 'title', 'slug'],
  post_tags: ['post_id', 'tag_id'],
  comments: ['id', 'post_id', 'author', 'content'],
};

export class ImportError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function asPositiveInt(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n < 1e15 ? n : null;
}

// 本站的列类型：这几列必须是整数，传字符串会让 SQLite 存成 TEXT，
// 之后按 id 排序、按区间回滚都会出问题。
const INT_COLS = new Set(['id', 'post_id', 'tag_id', 'parent_id', 'category_id', 'view_count', 'in_nav', 'is_admin', 'pin', 'sort']);

// 表里 NOT NULL 但导入方可能没给的列。少了这些默认值，
// 前端漏一个字段就会撞 NOT NULL 约束、整批 500 —— 而这些值本来就有「空的合理形态」。
const FILL = {
  posts: () => ({ excerpt: '', content_md: '', content_html: '', status: 'draft', view_count: 0, type: 'post', in_nav: 0, password: '', pin: 0 }),
  categories: () => ({ description: '', parent_id: 0, in_nav: 0 }),
  tags: () => ({}),
  post_tags: () => ({}),
  comments: () => ({ email: '', website: '', status: 'pending', is_admin: 0, ip: '' }),
};

const nowText = () => {
  const d = new Date(Date.now() + 8 * 3600e3);
  return d.toISOString().slice(0, 19).replace('T', ' ');
};

function normalizeRow(table, raw) {
  const cols = TABLES[table];
  const row = {};
  for (const c of cols) {
    let v = raw ? raw[c] : undefined;
    if (v === undefined) v = null;
    if (INT_COLS.has(c)) {
      if (v === null || v === '') v = c === 'parent_id' || c === 'category_id' || c === 'cover_key' ? null : 0;
      else {
        const n = Number(v);
        v = Number.isFinite(n) ? Math.trunc(n) : 0;
      }
    }
    if (typeof v === 'string') v = v.replace(/\u0000/g, '');
    row[c] = v;
  }
  const fill = (FILL[table] || (() => ({})))();
  for (const [k, v] of Object.entries(fill)) {
    if (row[k] === null) row[k] = v;
  }
  if (!row.created_at) row.created_at = nowText();
  if (table === 'posts' && !row.updated_at) row.updated_at = row.created_at;
  return row;
}

// 本站正文以 HTML 为准渲染，导进来的 Markdown 必须在这里补一份 HTML，
// 否则前台文章页是空白的（编辑器的预览可以后补，读者等不了）。
function fillHtml(row) {
  const html = String(row.content_html || '');
  if (html.trim()) return row;
  const md = String(row.content_md || '');
  if (!md.trim()) return row;
  try {
    row.content_html = renderMd(md);
  } catch (e) {
    row.content_html = '';
  }
  return row;
}

export async function insertBatch(db, table, rows) {
  if (!TABLES[table]) throw new ImportError('不支持的导入目标：' + table);
  if (!Array.isArray(rows) || !rows.length) return { table, inserted: 0 };
  if (rows.length > MAX_ROWS_PER_BATCH) throw new ImportError(`单批最多 ${MAX_ROWS_PER_BATCH} 行，收到 ${rows.length} 行`);

  const cols = TABLES[table];
  const need = REQUIRED[table];
  const prepared = [];
  const seenIds = new Set();

  for (const raw of rows) {
    const row = normalizeRow(table, raw);
    for (const c of need) {
      if (row[c] === null || row[c] === '') throw new ImportError(`${table} 缺少必填列 ${c}`);
    }
    const idc = table === 'post_tags' ? null : 'id';
    if (idc) {
      const id = asPositiveInt(row.id);
      if (!id) throw new ImportError(`${table} 的 id 必须是正整数`);
      if (seenIds.has(id)) throw new ImportError(`${table} 同一批里出现重复 id ${id}`);
      seenIds.add(id);
      row.id = id;
    }
    if (table === 'posts') fillHtml(row);
    prepared.push(row);
  }

  const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
  const stmts = prepared.map((row) => db.prepare(sql).bind(...cols.map((c) => (row[c] === undefined ? null : row[c]))));
  await db.batch(stmts);
  return { table, inserted: prepared.length };
}

// 本站现状：给浏览器算重编号用。
// 只返回 slug 与最大 id —— 足够判重，又不把整篇文章传出去。
export async function importMeta(db) {
  const one = async (sql) => {
    const r = await db.prepare(sql).first();
    return r ? Number(r.m || 0) : 0;
  };
  const [pMax, cMax, tMax, cmMax] = await Promise.all([
    one('SELECT MAX(id) AS m FROM posts'),
    one('SELECT MAX(id) AS m FROM categories'),
    one('SELECT MAX(id) AS m FROM tags'),
    one('SELECT MAX(id) AS m FROM comments'),
  ]);
  const slugs = async (sql) => {
    const r = await db.prepare(sql).all();
    return (r.results || []).map((x) => String(x.slug));
  };
  const [pSlug, cSlug, tSlug] = await Promise.all([
    slugs('SELECT slug FROM posts'),
    slugs('SELECT slug FROM categories'),
    slugs('SELECT slug FROM tags'),
  ]);
  const counts = async (sql) => {
    const r = await db.prepare(sql).first();
    return r ? Number(r.n || 0) : 0;
  };
  const [nPost, nPage, nComment] = await Promise.all([
    counts("SELECT COUNT(*) AS n FROM posts WHERE type='post'"),
    counts("SELECT COUNT(*) AS n FROM posts WHERE type='page'"),
    counts('SELECT COUNT(*) AS n FROM comments'),
  ]);
  return {
    maxIds: { posts: pMax, categories: cMax, tags: tMax, comments: cmMax },
    slugs: { posts: pSlug, categories: cSlug, tags: tSlug },
    counts: { posts: nPost, pages: nPage, comments: nComment },
  };
}

// 失败回滚：重编号的 id 是连续区间，按区间删就行，不必记每一条。
// 删除顺序必须从子到父，否则外键会拦（D1 默认开外键）。
// post_tags 不在这里删：它没有自己的 id，删 posts 时按 ON DELETE CASCADE 一起走。
const UNDO_ORDER = ['comments', 'posts', 'tags', 'categories'];

export async function undoImport(db, ranges) {
  let removed = 0;
  for (const table of UNDO_ORDER) {
    const r = ranges && ranges[table];
    if (!Array.isArray(r) || r.length !== 2) continue;
    const from = asPositiveInt(r[0]);
    const to = asPositiveInt(r[1]);
    if (!from || !to || to < from) continue;
    const res = await db.prepare(`DELETE FROM ${table} WHERE id BETWEEN ? AND ?`).bind(from, to).run();
    removed += Number((res.meta && res.meta.changes) || 0);
  }
  return { removed };
}

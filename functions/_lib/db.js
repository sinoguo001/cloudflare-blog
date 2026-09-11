// ============ D1 数据访问层 ============
import { bnNow, escLike, paginate, slugify } from './util.js';

// ---------- settings ----------
export async function getSetting(db, k, d = '') {
  const r = await db.prepare('SELECT value FROM settings WHERE key=?').bind(k).first();
  return r ? r.value : d;
}
export async function allSettings(db) {
  const r = await db.prepare('SELECT key,value FROM settings').all();
  const o = {};
  for (const x of r.results || []) o[x.key] = x.value;
  return o;
}
// 渲染层用 Map 形态（支持 s.get('key')）
export const settingsMap = async (db) => new Map(Object.entries(await allSettings(db)));
export async function setSetting(db, k, v) {
  await db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .bind(k, String(v ?? '')).run();
}
export const isInstalled = async (db) => !!((await getSetting(db, 'admin_username')));

// ---------- 唯一别名 ----------
async function uniqueSlug(db, table, base, excludeId) {
  // excludeId：更新时排除自己，否则编辑已发布文章会把 slug 追加成 post-2-2、post-2-2-2…
  const q = excludeId
    ? (s) => db.prepare(`SELECT 1 FROM ${table} WHERE slug=? AND id<>?`).bind(s, excludeId).first()
    : (s) => db.prepare(`SELECT 1 FROM ${table} WHERE slug=?`).bind(s).first();
  let slug = base || '';
  if (!(await q(slug))) return slug;
  for (let i = 2; i < 1000; i++) {
    const s = `${base}-${i}`;
    if (!(await q(s))) return s;
  }
  return `${base}-${Date.now()}`;
}

// ---------- posts ----------
const POST_SEL = `SELECT p.*, c.name AS cat_name, c.slug AS cat_slug
  FROM posts p LEFT JOIN categories c ON c.id=p.category_id`;

function rowOf(p) {
  return {
    ...p,
    category: p.category_id ? { id: p.category_id, name: p.cat_name, slug: p.cat_slug } : null,
    tags: [],
    comment_count: 0,
  };
}

export async function listPosts(db, { status = 'published', cat, tag, q, page = 1, per = 8 } = {}) {
  const where = [], b = [];
  if (status && status !== 'all') { where.push('p.status=?'); b.push(status); }
  if (cat) { where.push('c.slug=?'); b.push(cat); }
  if (tag) {
    where.push(`EXISTS(SELECT 1 FROM post_tags pt JOIN tags t ON t.id=pt.tag_id WHERE pt.post_id=p.id AND t.slug=?)`);
    b.push(tag);
  }
  if (q) {
    where.push(`(p.title LIKE ? ESCAPE '\\' OR p.excerpt LIKE ? ESCAPE '\\')`);
    const L = '%' + escLike(q) + '%';
    b.push(L, L);
  }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const cnt = await db.prepare(`SELECT COUNT(*) n FROM posts p LEFT JOIN categories c ON c.id=p.category_id ${w}`).bind(...b).first();
  const total = cnt ? cnt.n : 0;
  const pg = paginate(page, per, total);
  const rows = await db.prepare(`${POST_SEL} ${w} ORDER BY COALESCE(p.published_at,p.updated_at) DESC LIMIT ? OFFSET ?`)
    .bind(...b, per, pg.offset).all();
  const items = (rows.results || []).map(rowOf);
  await fillExtras(db, items);
  return { items, total, page: pg.p, pages: pg.pages, per };
}

async function fillExtras(db, items) {
  if (!items.length) return;
  const ids = items.map((x) => x.id);
  const ph = ids.map(() => '?').join(',');
  const tr = await db.prepare(
    `SELECT pt.post_id pid, t.id, t.name, t.slug FROM post_tags pt JOIN tags t ON t.id=pt.tag_id WHERE pt.post_id IN (${ph})`
  ).bind(...ids).all();
  for (const t of tr.results || []) {
    const it = items.find((x) => x.id === t.pid);
    if (it) it.tags.push({ id: t.id, name: t.name, slug: t.slug });
  }
  const cr = await db.prepare(
    `SELECT post_id pid, COUNT(*) n FROM comments WHERE post_id IN (${ph}) AND status='approved' GROUP BY post_id`
  ).bind(...ids).all();
  for (const c of cr.results || []) {
    const it = items.find((x) => x.id === c.pid);
    if (it) it.comment_count = c.n;
  }
}

export async function getPost(db, { id, slug } = {}) {
  const p = id
    ? await db.prepare(`${POST_SEL} WHERE p.id=?`).bind(id).first()
    : await db.prepare(`${POST_SEL} WHERE p.slug=?`).bind(slug).first();
  if (!p) return null;
  const post = rowOf(p);
  await fillExtras(db, [post]);
  return post;
}

export async function createPost(db, f) {
  const t = bnNow();
  const r = await db.prepare(
    `INSERT INTO posts(title,slug,excerpt,content_md,content_html,cover_key,status,category_id,created_at,updated_at,published_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(f.title, f.slug || '', f.excerpt || '', f.content_md || '', f.content_html || '',
    f.cover_key || null, f.status || 'draft', f.category_id || null, t, t,
    f.status === 'published' ? (f.published_at || t) : null).run();
  const id = r.meta.last_row_id;
  let slug = slugify(f.slug) || ('post-' + id);
  slug = await uniqueSlug(db, 'posts', slug);
  if (slug !== f.slug) await db.prepare('UPDATE posts SET slug=? WHERE id=?').bind(slug, id).run();
  if (f.tags && f.tags.length) await setPostTags(db, id, f.tags);
  return id;
}

export async function updatePost(db, id, f) {
  const old = await db.prepare('SELECT status,published_at FROM posts WHERE id=?').bind(id).first();
  if (!old) return false;
  const t = bnNow();
  const published_at = f.status === 'published'
    ? (old.published_at || f.published_at || t)
    : (f.status === 'draft' ? null : old.published_at);
  await db.prepare(
    `UPDATE posts SET title=?,slug=?,excerpt=?,content_md=?,content_html=?,cover_key=?,status=?,category_id=?,updated_at=?,published_at=? WHERE id=?`
  ).bind(f.title, f.slug || '', f.excerpt || '', f.content_md || '', f.content_html || '',
    f.cover_key || null, f.status || old.status, f.category_id || null, t, published_at, id).run();
  if (f.slug) {
    const slug = await uniqueSlug(db, 'posts', f.slug || ('post-' + id), id);
    if (slug !== f.slug) await db.prepare('UPDATE posts SET slug=? WHERE id=?').bind(slug, id).run();
  }
  if (f.tags) await setPostTags(db, id, f.tags);
  return true;
}

export async function deletePost(db, id) {
  await db.prepare('DELETE FROM comments WHERE post_id=?').bind(id).run();
  await db.prepare('DELETE FROM post_tags WHERE post_id=?').bind(id).run();
  await db.prepare('DELETE FROM posts WHERE id=?').bind(id).run();
}

// 仅切换发布/下线状态（不触碰正文，保留首次发布时间）
export async function setPostStatus(db, id, status) {
  const old = await db.prepare('SELECT published_at FROM posts WHERE id=?').bind(id).first();
  if (!old) return false;
  const t = bnNow();
  const published_at = status === 'published' ? (old.published_at || t) : null;
  await db.prepare('UPDATE posts SET status=?,published_at=?,updated_at=? WHERE id=?')
    .bind(status, published_at, t, id).run();
  return true;
}

export async function incView(db, slug) {
  await db.prepare('UPDATE posts SET view_count=view_count+1 WHERE slug=? AND status=\'published\'').bind(slug).run();
}

// 上一篇 / 下一篇（按发布时间）
export async function siblings(db, post) {
  if (!post.published_at) return { prev: null, next: null };
  const [prev, next] = await Promise.all([
    db.prepare(`SELECT id,title,slug FROM posts WHERE status='published' AND published_at<? ORDER BY published_at DESC LIMIT 1`).bind(post.published_at).first(),
    db.prepare(`SELECT id,title,slug FROM posts WHERE status='published' AND published_at>? ORDER BY published_at ASC LIMIT 1`).bind(post.published_at).first(),
  ]);
  return { prev, next };
}

// ---------- post_tags ----------
async function setPostTags(db, postId, names) {
  await db.prepare('DELETE FROM post_tags WHERE post_id=?').bind(postId).run();
  const seen = new Set();
  for (const raw of names) {
    const name = String(raw || '').trim();
    if (!name || name.length > 20 || seen.has(name)) continue;
    seen.add(name);
    let tag = await db.prepare('SELECT id FROM tags WHERE name=?').bind(name).first();
    if (!tag) {
      const t = bnNow();
      let slug = await uniqueSlug(db, 'tags', slugify(name) || ('tag-' + Date.now() % 1000000));
      const r = await db.prepare('INSERT INTO tags(name,slug,created_at) VALUES(?,?,?)').bind(name, slug, t).run();
      tag = { id: r.meta.last_row_id };
    }
    await db.prepare('INSERT OR IGNORE INTO post_tags(post_id,tag_id) VALUES(?,?)').bind(postId, tag.id).run();
  }
}

// ---------- categories ----------
export async function listCategories(db) {
  const r = await db.prepare(
    `SELECT c.*, (SELECT COUNT(*) FROM posts p WHERE p.category_id=c.id AND p.status='published') AS count
     FROM categories c ORDER BY c.id ASC`).all();
  return r.results || [];
}
export async function createCategory(db, { name, slug, description }) {
  const t = bnNow();
  const finalSlug = await uniqueSlug(db, 'categories', slugify(slug || name) || ('cat-' + Date.now() % 1000000));
  const r = await db.prepare('INSERT INTO categories(name,slug,description,created_at) VALUES(?,?,?,?)')
    .bind(name, finalSlug, description || '', t).run();
  return { id: r.meta.last_row_id, slug: finalSlug };
}
export async function updateCategory(db, id, { name, slug, description }) {
  // 必须传 excludeId=id：否则保存时自己的 slug 会被判成重名，别名被追加成 xxx-2，旧链接全部失效
  const finalSlug = await uniqueSlug(db, 'categories', slugify(slug || name) || ('cat-' + Date.now() % 1000000), id);
  await db.prepare('UPDATE categories SET name=?,slug=?,description=? WHERE id=?')
    .bind(name, finalSlug, description || '', id).run();
  // 回传最终别名：与提交值不同说明被别的分类占了，接口据此提示用户
  return finalSlug;
}
export async function deleteCategory(db, id) {
  await db.prepare('UPDATE posts SET category_id=NULL WHERE category_id=?').bind(id).run();
  await db.prepare('DELETE FROM categories WHERE id=?').bind(id).run();
}

// ---------- tags ----------
export async function listTags(db) {
  const r = await db.prepare(
    `SELECT t.*, (SELECT COUNT(*) FROM post_tags pt JOIN posts p ON p.id=pt.post_id
       WHERE pt.tag_id=t.id AND p.status='published') AS count
     FROM tags t ORDER BY t.id ASC`).all();
  return r.results || [];
}
export async function deleteTag(db, id) {
  await db.prepare('DELETE FROM post_tags WHERE tag_id=?').bind(id).run();
  await db.prepare('DELETE FROM tags WHERE id=?').bind(id).run();
}

// ---------- comments ----------
export async function listComments(db, { status, limit = 100, postId } = {}) {
  const w = [], b = [];
  // 注意：本查询联了 posts 表，两表都有 status / id 等列，条件必须限定别名 cm.
  if (status && status !== 'all') { w.push('cm.status=?'); b.push(status); }
  if (postId) { w.push('cm.post_id=?'); b.push(postId); }
  const wsql = w.length ? 'WHERE ' + w.join(' AND ') : '';
  const r = await db.prepare(
    `SELECT cm.*, p.title AS post_title, p.slug AS post_slug
     FROM comments cm LEFT JOIN posts p ON p.id=cm.post_id
     ${wsql} ORDER BY cm.id DESC LIMIT ?`).bind(...b, limit).all();
  return r.results || [];
}
export async function countPending(db) {
  const r = await db.prepare(`SELECT COUNT(*) n FROM comments WHERE status='pending'`).first();
  return r ? r.n : 0;
}
export async function getComment(db, id) {
  return db.prepare('SELECT * FROM comments WHERE id=?').bind(id).first();
}
// 文章已过审评论（含博主回复）
export async function commentsForPost(db, postId) {
  const r = await db.prepare(
    `SELECT id,parent_id,author,email,website,content,is_admin,created_at FROM comments
     WHERE post_id=? AND status='approved' ORDER BY id ASC`).bind(postId).all();
  return r.results || [];
}
export async function addComment(db, { postId, parentId = null, author, email, website = '', content, status, isAdmin = 0, ip }) {
  const t = bnNow();
  const r = await db.prepare(
    `INSERT INTO comments(post_id,parent_id,author,email,website,content,status,is_admin,ip,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?)`
  ).bind(postId, parentId, author, email || '', website || '', content, status, isAdmin, ip || '', t).run();
  return r.meta.last_row_id;
}
export async function setCommentStatus(db, id, status) {
  await db.prepare('UPDATE comments SET status=? WHERE id=?').bind(status, id).run();
}
export async function deleteComment(db, id) {
  await db.prepare('DELETE FROM comments WHERE id=? OR parent_id=?').bind(id, id).run();
}
export async function recentCommentsByIp(db, ip, seconds = 60) {
  const cutoff = new Date(Date.now() + 8 * 3600e3 - seconds * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const r = await db.prepare(`SELECT COUNT(*) n FROM comments WHERE ip=? AND created_at>?`).bind(ip || '-', cutoff).first();
  return r ? r.n : 0;
}

// ---------- 统计 ----------
export async function stats(db) {
  const s = (sql) => db.prepare(sql).first();
  const [posts, published, drafts, cats, tags, cmAll, cmPending] = await Promise.all([
    s(`SELECT COUNT(*) n FROM posts`), s(`SELECT COUNT(*) n FROM posts WHERE status='published'`),
    s(`SELECT COUNT(*) n FROM posts WHERE status='draft'`), s(`SELECT COUNT(*) n FROM categories`),
    s(`SELECT COUNT(*) n FROM tags`), s(`SELECT COUNT(*) n FROM comments`),
    s(`SELECT COUNT(*) n FROM comments WHERE status='pending'`),
  ]);
  const v = (r) => (r ? r.n : 0);
  return { posts: v(posts), published: v(published), drafts: v(drafts), categories: v(cats), tags: v(tags),
    comments: v(cmAll), pending: v(cmPending) };
}

// ---------- 站点访问统计（PV / UV，按天聚合） ----------
// 设计取舍：
// - 只按「天」聚合，不记每个路径：每天至多 1 行，写得少、查得快，也够仪表盘用
//   （文章维度的热度仍由 posts.view_count 承担，两套口径互不干扰）。
// - 表由代码首次写入时自动建立（CREATE TABLE IF NOT EXISTS），不要求手工跑 migration；
//   D1 支持在 Worker 里执行 DDL，失败也不影响浏览（调用方已 try/catch）。
const PV_DAILY = `CREATE TABLE IF NOT EXISTS pv_daily(
  day TEXT PRIMARY KEY, pv INTEGER NOT NULL DEFAULT 0, uv INTEGER NOT NULL DEFAULT 0)`;
// 访客明细仅用于「当天 UV 去重」，保留 60 天后清理
const PV_VISITOR = `CREATE TABLE IF NOT EXISTS pv_visitor(
  day TEXT NOT NULL, vid TEXT NOT NULL, PRIMARY KEY(day,vid))`;

let pvReady = false; // 同一 isolate 内只建一次，避免每个请求都跑 DDL
export async function ensurePvTables(db) {
  if (pvReady) return;
  await db.prepare(PV_DAILY).run();
  await db.prepare(PV_VISITOR).run();
  pvReady = true;
}

// day 形如 '2026-09-10'（北京时间），返回前 n 天的同一格式字符串
function shiftDay(day, n) {
  const t = Date.parse(day + 'T00:00:00+08:00') - n * 86400e3;
  return new Date(t + 8 * 3600e3).toISOString().slice(0, 10);
}

// 记一次访问；返回 1 表示当天新访客（UV +1），0 表示回访（只涨 PV）
export async function recordHit(db, day, vid) {
  await ensurePvTables(db);
  // 先查一次当天是否见过这个访客，而不是依赖 run() 返回的 meta.changes：
  // 各运行时对 changes 的语义不完全一致，写死依赖它一旦不成立，UV 会静默永远为 0。
  const seen = await db.prepare('SELECT 1 FROM pv_visitor WHERE day=? AND vid=?').bind(day, vid).first();
  const isNew = seen ? 0 : 1;
  if (isNew) await db.prepare('INSERT OR IGNORE INTO pv_visitor(day,vid) VALUES(?,?)').bind(day, vid).run();
  await db.prepare(
    `INSERT INTO pv_daily(day,pv,uv) VALUES(?,1,?)
     ON CONFLICT(day) DO UPDATE SET pv=pv+1, uv=uv+excluded.uv`
  ).bind(day, isNew).run();
  // 5% 概率顺手清理过期明细：既不会每次访问都多一条 DELETE，长期又能把表收住
  if (Math.random() < 0.05) {
    await db.prepare('DELETE FROM pv_visitor WHERE day<?').bind(shiftDay(day, 60)).run();
  }
  return isNew;
}

// 仪表盘用：累计 PV/UV、今日 PV/UV、最近 n 天趋势（无记录的日期补 0）
export async function pvSummary(db, days = 7) {
  await ensurePvTables(db);
  const today = bnNow().slice(0, 10);
  const [tot, rows] = await Promise.all([
    db.prepare('SELECT COALESCE(SUM(pv),0) pv, COALESCE(SUM(uv),0) uv FROM pv_daily').first(),
    db.prepare('SELECT day,pv,uv FROM pv_daily ORDER BY day DESC LIMIT ?').bind(days).all(),
  ]);
  const list = (rows && rows.results) || [];
  const todayRow = list.find((x) => x.day === today) || { pv: 0, uv: 0 };
  const trend = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = shiftDay(today, i);
    const r = list.find((x) => x.day === d);
    trend.push({ day: d, pv: r ? r.pv : 0, uv: r ? r.uv : 0 });
  }
  return {
    total_pv: (tot && tot.pv) || 0,
    total_uv: (tot && tot.uv) || 0,
    today_pv: todayRow.pv || 0,
    today_uv: todayRow.uv || 0,
    trend,
  };
}

// ---------- 友情链接 ----------
// 表结构与 migrations/0004_links.sql 一致，首次读写时自动建立，无需手工跑迁移。
export const LINK_STATUS = ['pending', 'approved', 'rejected'];
const LINK_DDL = `CREATE TABLE IF NOT EXISTS links(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, url TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', logo TEXT NOT NULL DEFAULT '',
  contact TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending',
  source TEXT NOT NULL DEFAULT 'admin', ip TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`;

let linkReady = false;
export async function ensureLinkTable(db) {
  if (linkReady) return;
  await db.prepare(LINK_DDL).run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_links_status ON links(status, sort, id DESC)').run();
  linkReady = true;
}

const LINK_COLS = 'id,name,url,description,logo,contact,reason,sort,status,source,created_at,updated_at';
export async function listLinks(db, { status = 'approved' } = {}) {
  await ensureLinkTable(db);
  const st = status && status !== 'all'
    ? db.prepare(`SELECT ${LINK_COLS} FROM links WHERE status=? ORDER BY sort ASC, id DESC`).bind(status)
    : db.prepare(`SELECT ${LINK_COLS} FROM links ORDER BY sort ASC, id DESC`);
  const r = await st.all();
  return r.results || [];
}
export async function countLinksByStatus(db) {
  await ensureLinkTable(db);
  const r = await db.prepare(`SELECT status, COUNT(*) n FROM links GROUP BY status`).all();
  const out = { pending: 0, approved: 0, rejected: 0 };
  ((r && r.results) || []).forEach((x) => { if (x.status in out) out[x.status] = x.n; });
  return out;
}
export async function getLink(db, id) {
  await ensureLinkTable(db);
  return db.prepare(`SELECT ${LINK_COLS} FROM links WHERE id=?`).bind(id).first();
}
// 同网址重复申请/重复添加要挡住（忽略协议与末尾斜杠差异）
export async function findLinkByUrl(db, url) {
  await ensureLinkTable(db);
  const norm = String(url || '').trim().replace(/\/+$/, '');
  const r = await db.prepare(`SELECT ${LINK_COLS} FROM links`).all();
  return ((r && r.results) || []).find((x) => String(x.url).trim().replace(/\/+$/, '') === norm) || null;
}
export async function addLink(db, d) {
  await ensureLinkTable(db);
  const now = bnNow();
  const r = await db.prepare(
    `INSERT INTO links(name,url,description,logo,contact,reason,sort,status,source,ip,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    d.name, d.url, d.description || '', d.logo || '', d.contact || '', d.reason || '',
    d.sort || 0, d.status || 'pending', d.source || 'admin', d.ip || '', now, now,
  ).run();
  // D1 与本地 SQLite 返回自增 id 的位置不一致，两种都取一遍
  return (r && r.meta && r.meta.last_row_id) || (r && r.lastInsertRowid) || 0;
}
export async function updateLink(db, id, patch) {
  await ensureLinkTable(db);
  const allow = ['name', 'url', 'description', 'logo', 'contact', 'reason', 'sort', 'status'];
  const keys = Object.keys(patch || {}).filter((k) => allow.includes(k));
  if (!keys.length) return 0;
  // status 走白名单，避免把非法值写进去
  if (keys.includes('status') && !LINK_STATUS.includes(patch.status)) return 0;
  const sql = `UPDATE links SET ${keys.map((k) => `${k}=?`).join(',')}, updated_at=? WHERE id=?`;
  const vals = keys.map((k) => patch[k]);
  await db.prepare(sql).bind(...vals, bnNow(), id).run();
  return 1;
}
export async function deleteLink(db, id) {
  await ensureLinkTable(db);
  await db.prepare('DELETE FROM links WHERE id=?').bind(id).run();
}
export async function recentLinkApplies(db, ip, seconds = 3600) {
  await ensureLinkTable(db);
  const cutoff = new Date(Date.now() + 8 * 3600e3 - seconds * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const r = await db.prepare(`SELECT COUNT(*) n FROM links WHERE source='apply' AND ip=? AND created_at>?`)
    .bind(ip || '-', cutoff).first();
  return r ? r.n : 0;
}

// ---------- 归档 / 全量导出（备份用） ----------
export async function archivePosts(db) {
  const r = await db.prepare(
    `SELECT id,title,slug,published_at FROM posts WHERE status='published' ORDER BY published_at DESC`).all();
  return r.results || [];
}
export async function dumpAll(db) {
  const g = async (sql) => (await db.prepare(sql).all()).results || [];
  return {
    exported_at: bnNow(),
    settings: await g('SELECT * FROM settings'),
    categories: await g('SELECT * FROM categories'),
    tags: await g('SELECT * FROM tags'),
    posts: await g('SELECT * FROM posts'),
    post_tags: await g('SELECT * FROM post_tags'),
    comments: await g('SELECT * FROM comments'),
    // 访问统计只备份按天汇总（pv_daily），访客明细 pv_visitor 是去重用的临时数据，不进备份
    pv_daily: await g('SELECT * FROM pv_daily').catch(() => []),
    links: await g('SELECT * FROM links').catch(() => []),
  };
}
// 恢复：先清空再按原 id 回填（自动续接自增序列）
export async function restoreAll(db, data) {
  // 访问统计表可能还没建（老库），先确保存在再清空，否则 DELETE 会报 no such table
  await ensurePvTables(db).catch(() => {});
  await ensureLinkTable(db).catch(() => {});
  const clear = [
    'DELETE FROM post_tags', 'DELETE FROM comments', 'DELETE FROM posts',
    'DELETE FROM categories', 'DELETE FROM tags', 'DELETE FROM pv_daily', 'DELETE FROM links',
    "DELETE FROM settings WHERE key NOT IN ('admin_username','admin_pass_salt','admin_pass_hash','admin_pass_iter')",
  ];
  const stmts = clear.map((s) => db.prepare(s));
  const chunk = [];
  const run = async (list, sql) => {
    for (const row of list) {
      const keys = Object.keys(row);
      const vals = keys.map((k) => row[k]);
      chunk.push(db.prepare(`INSERT OR REPLACE INTO ${sql}(${keys.join(',')}) VALUES(${vals.map(() => '?').join(',')})`).bind(...vals));
    }
  };
  if (data.settings) await run(data.settings.filter((s) => !/^admin_/.test(s.key)), 'settings');
  if (data.categories) await run(data.categories, 'categories');
  if (data.tags) await run(data.tags, 'tags');
  if (data.posts) await run(data.posts, 'posts');
  if (data.post_tags) await run(data.post_tags, 'post_tags');
  if (data.comments) await run(data.comments, 'comments');
  if (data.pv_daily) await run(data.pv_daily, 'pv_daily');
  if (data.links) await run(data.links, 'links');
  for (let i = 0; i < chunk.length; i += 40) await db.batch(chunk.slice(i, i + 40));
  return chunk.length;
}

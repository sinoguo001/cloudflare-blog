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
async function uniqueSlug(db, table, base) {
  let slug = base || '';
  const seen = await db.prepare(`SELECT 1 FROM ${table} WHERE slug=?`).bind(slug).first();
  if (!seen) return slug;
  for (let i = 2; i < 1000; i++) {
    const s = `${base}-${i}`;
    if (!(await db.prepare(`SELECT 1 FROM ${table} WHERE slug=?`).bind(s).first())) return s;
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
  return r.meta.last_row_id;
}
export async function updateCategory(db, id, { name, slug, description }) {
  const finalSlug = await uniqueSlug(db, 'categories', slugify(slug || name) || ('cat-' + Date.now() % 1000000));
  await db.prepare('UPDATE categories SET name=?,slug=?,description=? WHERE id=?')
    .bind(name, finalSlug, description || '', id).run();
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
    `SELECT id,parent_id,author,website,content,is_admin,created_at FROM comments
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
  };
}
// 恢复：先清空再按原 id 回填（自动续接自增序列）
export async function restoreAll(db, data) {
  const clear = [
    'DELETE FROM post_tags', 'DELETE FROM comments', 'DELETE FROM posts',
    'DELETE FROM categories', 'DELETE FROM tags',
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
  for (let i = 0; i < chunk.length; i += 40) await db.batch(chunk.slice(i, i + 40));
  return chunk.length;
}

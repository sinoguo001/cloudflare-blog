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

// ---------- posts 表结构兜底（Ver 0.4 独立页面） ----------
// type / in_nav 两列由 migrations/0005_pages.sql 建立。万一使用者部署后没跑迁移，
// 这里在首次访问时自动补上，避免前台因为「no such column: p.type」整站 500。
// D1 支持在 Worker 里执行 ALTER TABLE，故不需要本地工具链。
let postColsReady = false;
export async function ensurePostCols(db) {
  if (postColsReady) return;
  try {
    const r = await db.prepare('PRAGMA table_info(posts)').all();
    const cols = new Set(((r && r.results) || []).map((x) => x.name));
    if (!cols.size) return;                      // 表还没建（未初始化），等下次请求再试
    if (!cols.has('type')) await db.prepare("ALTER TABLE posts ADD COLUMN type TEXT NOT NULL DEFAULT 'post'").run();
    if (!cols.has('in_nav')) await db.prepare('ALTER TABLE posts ADD COLUMN in_nav INTEGER NOT NULL DEFAULT 1').run();
    // 文章访问密码（空串=不加密）
    if (!cols.has('password')) await db.prepare("ALTER TABLE posts ADD COLUMN password TEXT NOT NULL DEFAULT ''").run();
    // 文章置顶优先级（0=不置顶，越大越靠前）；列表排序要用，缺列会整站 500
    if (!cols.has('pin')) await db.prepare('ALTER TABLE posts ADD COLUMN pin INTEGER NOT NULL DEFAULT 0').run();
    postColsReady = true;
    // 顺带补 categories：文章查询要联父分类别名，少这一列会整站 500
    await ensureCatCols(db);
  } catch (e) { /* 补列失败不阻断浏览：没有这两列时页面功能不可用，但文章照常 */ }
}

// 访问密码：空=不加密；不传（null/undefined）表示「本次不改」，与「主动清空」区分开
export const postPass = (v) => (v == null ? '' : String(v).slice(0, 64));

// ---------- categories 表结构兜底（Ver 0.4 二级分类） ----------
// parent_id 由 migrations/0006_subcats.sql 建立，没跑迁移时这里自动补，避免整站 500。
let catColsReady = false;
export async function ensureCatCols(db) {
  if (catColsReady) return;
  try {
    const r = await db.prepare('PRAGMA table_info(categories)').all();
    const cols = new Set(((r && r.results) || []).map((x) => x.name));
    if (!cols.size) return;
    if (!cols.has('parent_id')) await db.prepare('ALTER TABLE categories ADD COLUMN parent_id INTEGER NOT NULL DEFAULT 0').run();
    // 导航栏开关：默认 0，升级后导航栏与旧版一致
    if (!cols.has('in_nav')) await db.prepare('ALTER TABLE categories ADD COLUMN in_nav INTEGER NOT NULL DEFAULT 0').run();
    catColsReady = true;
  } catch (e) { /* 补列失败时按「全是顶级分类」继续跑，不阻断浏览 */ }
}

// ---------- posts ----------
// 多带一层父分类别名：二级分类的访问地址是 /category/父别名/子别名
const POST_SEL = `SELECT p.*, c.name AS cat_name, c.slug AS cat_slug,
  (SELECT pc.slug FROM categories pc WHERE pc.id=c.parent_id) AS cat_parent_slug,
  (SELECT pc.name FROM categories pc WHERE pc.id=c.parent_id) AS cat_parent_name
  FROM posts p LEFT JOIN categories c ON c.id=p.category_id`;

// 二级分类的完整路径别名：顶级是自己，二级是「父/子」
export const catFullSlug = (c) =>
  (c && c.parent_slug ? c.parent_slug + '/' : '') + String((c && c.slug) || '');

function rowOf(p) {
  return {
    ...p,
    // 是否加密：前台据此隐藏摘要与正文。只暴露布尔值，不因此泄露密码本身
    locked: !!String(p.password || ''),
    category: p.category_id ? {
      id: p.category_id, name: p.cat_name, slug: p.cat_slug,
      full_slug: (p.cat_parent_slug ? p.cat_parent_slug + '/' : '') + (p.cat_slug || ''),
      parent_name: p.cat_parent_name || '', parent_slug: p.cat_parent_slug || '',
    } : null,
    tags: [],
    comment_count: 0,
    // 置顶（Ver 0.4 ⑪）：pin 是优先级数值（0=未置顶），pinned 只是给模板用的布尔值。
    // 前台角标一律看 pinned，避免模板里到处写 p.pin > 0。
    pinned: Number(p.pin) > 0,
    pin: Number(p.pin) || 0,
    // 点赞数：由 fillExtras 批量回填（表还没建或查询失败就是 0，不影响浏览）
    likes: p.like_count ? Number(p.like_count) : 0,
    // 当前访客是否已赞：仅在文章详情页单独查询后覆盖，列表页恒为 false
    liked: false,
  };
}

// type：'post' 文章（默认）| 'page' 独立页面 | 'all' 两者都要
// 默认只取文章：首页 / 分类 / 标签 / 归档 / 搜索 / RSS 都不该出现「关于我」这类页面，
// 除非调用方显式传 type，页面由此天然与文章流隔离。
export async function listPosts(db, { status = 'published', type = 'post', cat, tag, q, inNav, unlockedOnly, pinFirst = true, page = 1, per = 8 } = {}) {
  await ensurePostCols(db);
  await ensureCatCols(db);
  const where = [], b = [];
  if (status && status !== 'all') { where.push('p.status=?'); b.push(status); }
  if (type && type !== 'all') { where.push('p.type=?'); b.push(type); }
  if (unlockedOnly) where.push("(p.password IS NULL OR p.password='')");
  if (inNav) where.push('p.in_nav=1');
  if (cat) {
    await ensureCatCols(db);
    // 传的是别名：先换成 id，再看有没有二级分类——父分类页要把子分类的文章一起带出来
    const c = await db.prepare('SELECT id FROM categories WHERE slug=?').bind(cat).first();
    let ids = [];
    if (c) {
      const kids = await db.prepare('SELECT id FROM categories WHERE parent_id=?').bind(c.id).all();
      ids = [c.id, ...(kids.results || []).map((k) => k.id)];
    }
    // 查不到这个分类就返回空，绝不能退化成「不过滤」把所有文章都列出来
    where.push(ids.length ? `p.category_id IN (${ids.map(() => '?').join(',')})` : '1=0');
    b.push(...ids);
  }
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
  // 置顶优先（Ver 0.4 ⑪）：pin 大的排最前；未置顶的文章 pin 都是 0，自然回到时间倒序。
  // 归档页走 archivePosts（按时间分组），不受这里影响；pinFirst=false 给「最近文章」这类
  // 语义上必须严格按时间的列表用。
  const order = pinFirst
    ? 'ORDER BY p.pin DESC, COALESCE(p.published_at,p.updated_at) DESC'
    : 'ORDER BY COALESCE(p.published_at,p.updated_at) DESC';
  const rows = await db.prepare(`${POST_SEL} ${w} ${order} LIMIT ? OFFSET ?`)
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
  // 点赞数：单独查一次并 try 包住——点赞表还没建起来时只是显示不出数字，文章照常能看
  try {
    const lc = await likeCounts(db, ids);
    for (const it of items) it.likes = lc[it.id] || 0;
  } catch (e) { /* 点赞挂了不连累正文 */ }
}

export async function getPost(db, { id, slug } = {}) {
  // POST_SEL 里取了父分类别名，没跑 0006 迁移会报 no such column: c.parent_id，先补列
  await ensureCatCols(db);
  const p = id
    ? await db.prepare(`${POST_SEL} WHERE p.id=?`).bind(id).first()
    : await db.prepare(`${POST_SEL} WHERE p.slug=?`).bind(slug).first();
  if (!p) return null;
  const post = rowOf(p);
  await fillExtras(db, [post]);
  return post;
}

export async function createPost(db, f) {
  await ensurePostCols(db);
  const t = bnNow();
  const type = f.type === 'page' ? 'page' : 'post';
  const inNav = f.in_nav == null ? 1 : (f.in_nav ? 1 : 0);
  const r = await db.prepare(
    `INSERT INTO posts(title,slug,excerpt,content_md,content_html,cover_key,status,category_id,type,in_nav,password,created_at,updated_at,published_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(f.title, f.slug || '', f.excerpt || '', f.content_md || '', f.content_html || '',
    f.cover_key || null, f.status || 'draft', f.category_id || null, type, inNav,
    postPass(f.password), t, t,
    f.status === 'published' ? (f.published_at || t) : null).run();
  const id = r.meta.last_row_id;
  let slug = slugify(f.slug) || ((type === 'page' ? 'page-' : 'post-') + id);
  // excludeId 必须传：INSERT 时已把 f.slug 写进去了，不排除自己就会撞上自己、被追加成 -2
  slug = await uniqueSlug(db, 'posts', slug, id);
  if (slug !== f.slug) await db.prepare('UPDATE posts SET slug=? WHERE id=?').bind(slug, id).run();
  if (f.tags && f.tags.length) await setPostTags(db, id, f.tags);
  return id;
}

export async function updatePost(db, id, f) {
  await ensurePostCols(db);
  const old = await db.prepare('SELECT status,published_at,slug FROM posts WHERE id=?').bind(id).first();
  if (!old) return false;
  const t = bnNow();
  const published_at = f.status === 'published'
    ? (old.published_at || f.published_at || t)
    : (f.status === 'draft' ? null : old.published_at);
  // 没传别名就保留原来的：以前会写进空串，既让地址变成 /post/，又会在下次保存时撞 UNIQUE
  const finalSlug = String(f.slug || '').trim() || old.slug || ('post-' + id);
  // type / in_nav 只在调用方显式传了才更新：文章编辑接口不传，就不会把文章改成页面
  const sets = ['title=?', 'slug=?', 'excerpt=?', 'content_md=?', 'content_html=?',
    'cover_key=?', 'status=?', 'category_id=?', 'updated_at=?', 'published_at=?'];
  const vals = [f.title, finalSlug, f.excerpt || '', f.content_md || '', f.content_html || '',
    f.cover_key || null, f.status || old.status, f.category_id || null, t, published_at];
  if (f.type) { sets.push('type=?'); vals.push(f.type === 'page' ? 'page' : 'post'); }
  if (f.in_nav != null) { sets.push('in_nav=?'); vals.push(f.in_nav ? 1 : 0); }
  // 只有显式传了才改密码：文章编辑器每次都传（未勾选传空串＝取消加密），
  // 页面编辑器不传，就不会把已有密码冲掉
  if (f.password != null) { sets.push('password=?'); vals.push(postPass(f.password)); }
  await db.prepare(
    `UPDATE posts SET ${sets.join(',')} WHERE id=?`
  ).bind(...vals, id).run();
  // 别名被别人占了就追加序号（excludeId 传 id，避免把自己判成重名）
  const slug = await uniqueSlug(db, 'posts', finalSlug, id);
  if (slug !== finalSlug) await db.prepare('UPDATE posts SET slug=? WHERE id=?').bind(slug, id).run();
  if (f.tags) await setPostTags(db, id, f.tags);
  return true;
}

export async function deletePost(db, id) {
  await db.prepare('DELETE FROM comments WHERE post_id=?').bind(id).run();
  await db.prepare('DELETE FROM post_tags WHERE post_id=?').bind(id).run();
  await db.prepare('DELETE FROM posts WHERE id=?').bind(id).run();
  // 点赞记录跟着删：不清会留下孤儿行，日后新建文章复用 id 时会凭空多出赞
  try { await db.prepare('DELETE FROM post_likes WHERE post_id=?').bind(id).run(); } catch (e) { /* 表没建过就算了 */ }
}

// ---------- 文章点赞（Ver 0.4 ⑦） ----------
// 设计取舍：
// - 独立一张表，不给 posts 加 likes 冗余列：冗余列要和维护点赞表同步，两处写入一旦
//   不一致就很难查；COUNT 查询在博客这个量级下开销可以忽略。
// - 同一访客（blog_vid Cookie）对同一篇文章只能赞一次，再点一次是取消，所以不需要
//   额外的限频逻辑——重复点击天然在「赞 / 取消」之间摆动。
// - 表由代码首次用到时自动建立（CREATE TABLE IF NOT EXISTS），不强制跑迁移；
//   老库不跑 0009 也能用，只是少了索引（本表主键即索引）。
const LIKE_DDL = `CREATE TABLE IF NOT EXISTS post_likes(
  post_id INTEGER NOT NULL, vid TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(post_id,vid))`;

let likeReady = false; // 同一 isolate 内只建一次，避免每个请求都跑 DDL
export async function ensureLikeTable(db) {
  if (likeReady) return;
  await db.prepare(LIKE_DDL).run();
  likeReady = true;
}

// 批量取点赞数：返回 { 文章id: 数量 }，没被赞过的文章不在结果里（调用方按 0 处理）
export async function likeCounts(db, ids) {
  const out = {};
  if (!ids || !ids.length) return out;
  await ensureLikeTable(db);
  const ph = ids.map(() => '?').join(',');
  const r = await db.prepare(
    `SELECT post_id, COUNT(*) n FROM post_likes WHERE post_id IN (${ph}) GROUP BY post_id`
  ).bind(...ids).all();
  for (const x of r.results || []) out[x.post_id] = x.n;
  return out;
}

// 切换点赞：返回 { liked, likes }；liked 为 true 表示这次点完是「已赞」
export async function toggleLike(db, postId, vid) {
  await ensureLikeTable(db);
  const has = await db.prepare('SELECT 1 FROM post_likes WHERE post_id=? AND vid=?').bind(postId, vid).first();
  if (has) {
    await db.prepare('DELETE FROM post_likes WHERE post_id=? AND vid=?').bind(postId, vid).run();
  } else {
    await db.prepare('INSERT INTO post_likes(post_id,vid,created_at) VALUES(?,?,?)')
      .bind(postId, vid, bnNow()).run();
  }
  return await likeState(db, postId, vid);
}

// 只读当前状态：给文章详情页回填「我赞过没」
export async function likeState(db, postId, vid) {
  await ensureLikeTable(db);
  const mine = vid
    ? await db.prepare('SELECT 1 FROM post_likes WHERE post_id=? AND vid=?').bind(postId, vid).first() : null;
  const c = await db.prepare('SELECT COUNT(*) n FROM post_likes WHERE post_id=?').bind(postId).first();
  return { liked: !!mine, likes: c ? c.n : 0 };
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

// ---------- 文章置顶（Ver 0.4 ⑪） ----------
// 取舍：只用 posts 上的一个 pin 整数，不另开置顶表 —— 置顶是文章自己的属性，跟着文章走最直观；
// 删文章不需要额外清理，备份（dumpAll 用 SELECT *）与恢复（按键名回填）都不用专门照顾。
// pin 的数值由服务端独占维护：每次变动都按当前展示顺序把已置顶文章重排成连续的 1..N
// （排最前的那篇 pin = N 最大，最后那篇 = 1）。因此永远不会出现并列，也不依赖魔法数值。
async function pinnedIds(db) {
  const r = await db.prepare(
    "SELECT id FROM posts WHERE pin>0 AND type='post' ORDER BY pin DESC, id ASC"
  ).all();
  return (r.results || []).map((x) => x.id);
}

// action：'toggle' 置顶／取消置顶 | 'up' 上移一位 | 'down' 下移一位
// 返回 { ok, list }：list 是调整后的置顶 id 顺序（从前到后），调用方可以直接用来重排界面。
export async function pinPost(db, id, action) {
  await ensurePostCols(db);
  const post = await db.prepare('SELECT id,status,type FROM posts WHERE id=?').bind(id).first();
  if (!post) return { ok: false, code: 404, error: '文章不存在' };
  if (post.type !== 'post') return { ok: false, code: 400, error: '独立页面不支持置顶' };

  let list = await pinnedIds(db);
  const at = list.indexOf(id);

  if (action === 'toggle') {
    // 草稿不给置顶：前台本来就看不到它，占着优先级只会让人以为置顶失效了
    if (at < 0 && post.status !== 'published') {
      return { ok: false, code: 400, error: '草稿不能置顶，请先发布' };
    }
    // 新置顶的排最前：刚点完就能在列表顶部看到它，符合直觉
    list = at >= 0 ? list.filter((x) => x !== id) : [id, ...list];
  } else if (action === 'up' || action === 'down') {
    if (at < 0) return { ok: false, code: 400, error: '这篇文章没有置顶' };
    const to = action === 'up' ? at - 1 : at + 1;
    if (to < 0 || to >= list.length) return { ok: true, list, moved: false }; // 已在顶/底，静默不动
    list[at] = list[to];
    list[to] = id;
  } else {
    return { ok: false, code: 400, error: '不支持的操作' };
  }

  // 回写：先把所有置顶清零，再按新顺序赋连续值。即使库里因历史原因有脏数据也会被一并修正。
  const n = list.length;
  const stmts = [db.prepare('UPDATE posts SET pin=0 WHERE pin<>0')];
  list.forEach((pid, i) => stmts.push(db.prepare('UPDATE posts SET pin=? WHERE id=?').bind(n - i, pid)));
  await db.batch(stmts);
  return { ok: true, list };
}

export async function incView(db, slug) {
  await db.prepare('UPDATE posts SET view_count=view_count+1 WHERE slug=? AND status=\'published\'').bind(slug).run();
}

// 上一篇 / 下一篇（按发布时间）
export async function siblings(db, post) {
  await ensurePostCols(db);
  if (!post.published_at) return { prev: null, next: null };
  // 页面（type=page）不参与上一篇 / 下一篇，这里与调用处双重限定
  // 带上 published_at 与分类别名：永久链接规则可能用到 {year} {month} {day} {category}
  const SEL = `SELECT p.id,p.title,p.slug,p.published_at,c.slug AS cat_slug
    FROM posts p LEFT JOIN categories c ON c.id=p.category_id`;
  const [prev, next] = await Promise.all([
    db.prepare(`${SEL} WHERE p.status='published' AND p.type='post' AND p.published_at<? ORDER BY p.published_at DESC LIMIT 1`).bind(post.published_at).first(),
    db.prepare(`${SEL} WHERE p.status='published' AND p.type='post' AND p.published_at>? ORDER BY p.published_at ASC LIMIT 1`).bind(post.published_at).first(),
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
// 只支持两级：顶级（parent_id=0）与挂在顶级下的二级分类。
// 返回 full_slug（父/子）供前台拼地址；count 含二级分类的文章，与父分类页实际列出的数量一致。
export async function listCategories(db) {
  await ensureCatCols(db);
  const r = await db.prepare(
    `SELECT c.*, p.slug AS parent_slug, p.name AS parent_name,
       (SELECT COUNT(*) FROM posts po WHERE po.status='published'
          AND (po.category_id=c.id OR po.category_id IN (SELECT id FROM categories WHERE parent_id=c.id))) AS count
     FROM categories c LEFT JOIN categories p ON p.id=c.parent_id
     ORDER BY c.parent_id ASC, c.id ASC`).all();
  const rows = r.results || [];
  for (const c of rows) c.full_slug = catFullSlug(c);
  return rows;
}
// 顶级分类在前、其下二级紧随其后，供后台列表与前台总览按树形渲染
export function treeCategories(list) {
  const tops = list.filter((c) => !c.parent_id);
  const out = [];
  for (const t of tops) {
    out.push(t);
    for (const c of list) if (c.parent_id === t.id) out.push(c);
  }
  // 父分类被删掉而子分类还没清理的极端情况：别把孤儿藏起来
  for (const c of list) if (!out.includes(c)) out.push(c);
  return out;
}
// 导航栏要显示的分类：in_nav=1 的顶级分类，自带的二级分类挂在 children 里
// （二级分类不单独占导航位，只在父分类的下拉里出现）
export async function navCategories(db) {
  const all = await listCategories(db);
  return all
    .filter((c) => !c.parent_id && Number(c.in_nav) === 1)
    .map((t) => ({ ...t, children: all.filter((c) => Number(c.parent_id) === Number(t.id)) }));
}
export async function createCategory(db, { name, slug, description, parent_id, in_nav }) {
  await ensureCatCols(db);
  const t = bnNow();
  // 上级只能是顶级分类：这样天然不会出现三层，也不会成环
  const pid = parent_id ? await topCategoryId(db, parent_id) : 0;
  // 二级分类不占导航位（跟着父分类在下拉里出现），所以强制置 0，避免存了不生效的脏数据
  const nav = pid ? 0 : (in_nav ? 1 : 0);
  const finalSlug = await uniqueSlug(db, 'categories', slugify(slug || name) || ('cat-' + Date.now() % 1000000));
  const r = await db.prepare('INSERT INTO categories(name,slug,description,parent_id,in_nav,created_at) VALUES(?,?,?,?,?,?)')
    .bind(name, finalSlug, description || '', pid, nav, t).run();
  return { id: r.meta.last_row_id, slug: finalSlug, parent_id: pid, in_nav: nav };
}
export async function updateCategory(db, id, { name, slug, description, parent_id, in_nav }) {
  await ensureCatCols(db);
  const cur = await db.prepare('SELECT parent_id,in_nav FROM categories WHERE id=?').bind(id).first();
  // 上级只接受「顶级分类」或「回到顶级」：传了非顶级就沿用原值
  const pid = parent_id ? await topCategoryId(db, parent_id, id) : (parent_id === 0 ? 0 : (cur ? cur.parent_id : 0));
  // 变成二级分类就自动退出导航栏；没传 in_nav 时保持原值
  const nav = pid ? 0 : (in_nav == null ? Number(cur ? cur.in_nav : 0) || 0 : (in_nav ? 1 : 0));
  // 必须传 excludeId=id：否则保存时自己的 slug 会被判成重名，别名被追加成 xxx-2，旧链接全部失效
  const finalSlug = await uniqueSlug(db, 'categories', slugify(slug || name) || ('cat-' + Date.now() % 1000000), id);
  await db.prepare('UPDATE categories SET name=?,slug=?,description=?,parent_id=?,in_nav=? WHERE id=?')
    .bind(name, finalSlug, description || '', pid, nav, id).run();
  // 回传最终别名：与提交值不同说明被别的分类占了，接口据此提示用户
  return finalSlug;
}
// 只有顶级分类能当别人的上级；传进来的 id 无效或不是顶级就返回 0（降级为顶级，不报错）
async function topCategoryId(db, id, selfId) {
  const p = await db.prepare('SELECT id,parent_id FROM categories WHERE id=?').bind(id).first();
  if (!p) return 0;
  if (selfId && Number(p.id) === Number(selfId)) return 0;   // 不能挂到自己名下
  if (p.parent_id) return 0;                                  // 二级分类不能再有下级
  return p.id;
}
export async function deleteCategory(db, id) {
  await ensureCatCols(db);
  // 删父不删子：子分类自动升为顶级，文章链接还留着，只是地址少了一层（路由会 301 过去）
  await db.prepare('UPDATE categories SET parent_id=0 WHERE parent_id=?').bind(id).run();
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
  await ensurePostCols(db);
  const s = (sql) => db.prepare(sql).first();
  // 文章数与页面数分开统计：仪表盘「文章 N 篇」不该把「关于我」这类页面算进去
  const [posts, published, drafts, pages, cats, tags, cmAll, cmPending] = await Promise.all([
    s(`SELECT COUNT(*) n FROM posts WHERE type='post'`),
    s(`SELECT COUNT(*) n FROM posts WHERE type='post' AND status='published'`),
    s(`SELECT COUNT(*) n FROM posts WHERE type='post' AND status='draft'`),
    s(`SELECT COUNT(*) n FROM posts WHERE type='page'`),
    s(`SELECT COUNT(*) n FROM categories`),
    s(`SELECT COUNT(*) n FROM tags`), s(`SELECT COUNT(*) n FROM comments`),
    s(`SELECT COUNT(*) n FROM comments WHERE status='pending'`),
  ]);
  const v = (r) => (r ? r.n : 0);
  return { posts: v(posts), published: v(published), drafts: v(drafts), pages: v(pages),
    categories: v(cats), tags: v(tags), comments: v(cmAll), pending: v(cmPending) };
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

// ---------- 友圈（Ver 0.4 ⑫）：订阅别人的 RSS ----------
// 表结构与 migrations/0011_friends.sql 一致，首次读写时自动建立，无需手工跑迁移。
const FEED_DDL = `CREATE TABLE IF NOT EXISTS friend_feeds(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT '', url TEXT NOT NULL,
  site_url TEXT NOT NULL DEFAULT '', avatar TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '', sort INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_fetch TEXT NOT NULL DEFAULT '', last_status INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`;
const FPOST_DDL = `CREATE TABLE IF NOT EXISTS friend_posts(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feed_id INTEGER NOT NULL, guid TEXT NOT NULL,
  title TEXT NOT NULL, link TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '', author TEXT NOT NULL DEFAULT '',
  published_at TEXT NOT NULL, fetched_at TEXT NOT NULL)`;

let friendReady = false;
export async function ensureFriendTables(db) {
  if (friendReady) return;
  await db.prepare(FEED_DDL).run();
  await db.prepare(FPOST_DDL).run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_ffeed_enabled ON friend_feeds(enabled, sort, id)').run();
  await db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_fpost_uniq ON friend_posts(feed_id, guid)').run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_fpost_time ON friend_posts(published_at DESC, id DESC)').run();
  friendReady = true;
}

const FEED_COLS = 'id,name,url,site_url,avatar,description,sort,enabled,last_fetch,last_status,last_error,created_at,updated_at';
// 顺带带出「已抓文章数」和「最新一篇的时间」，后台列表直接显示，省一次请求
export async function listFeeds(db, { enabledOnly = false } = {}) {
  await ensureFriendTables(db);
  const r = await db.prepare(
    `SELECT ${FEED_COLS},
       (SELECT COUNT(*) FROM friend_posts fp WHERE fp.feed_id = friend_feeds.id) AS post_count,
       (SELECT MAX(fp.published_at) FROM friend_posts fp WHERE fp.feed_id = friend_feeds.id) AS latest_at
     FROM friend_feeds${enabledOnly ? ' WHERE enabled=1' : ''} ORDER BY sort ASC, id ASC`
  ).all();
  return r.results || [];
}
export async function countFeeds(db) {
  await ensureFriendTables(db);
  const r = await db.prepare('SELECT COUNT(*) n FROM friend_feeds').first();
  return r ? r.n : 0;
}
export async function getFeed(db, id) {
  await ensureFriendTables(db);
  return db.prepare(`SELECT ${FEED_COLS} FROM friend_feeds WHERE id=?`).bind(id).first();
}
// 同一个订阅地址不重复添加（忽略末尾斜杠差异）
export async function findFeedByUrl(db, url) {
  await ensureFriendTables(db);
  const norm = String(url || '').trim().replace(/\/+$/, '');
  const r = await db.prepare(`SELECT ${FEED_COLS} FROM friend_feeds`).all();
  return ((r && r.results) || []).find((x) => String(x.url).trim().replace(/\/+$/, '') === norm) || null;
}
export async function addFeed(db, d) {
  await ensureFriendTables(db);
  const now = bnNow();
  const r = await db.prepare(
    `INSERT INTO friend_feeds(name,url,site_url,avatar,description,sort,enabled,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?)`
  ).bind(
    d.name || '', d.url, d.site_url || '', d.avatar || '', d.description || '',
    parseInt(d.sort, 10) || 0, d.enabled === 0 || d.enabled === false ? 0 : 1, now, now,
  ).run();
  return (r && r.meta && r.meta.last_row_id) || (r && r.lastInsertRowid) || 0;
}
export async function updateFeed(db, id, patch) {
  await ensureFriendTables(db);
  const allow = ['name', 'url', 'site_url', 'avatar', 'description', 'sort', 'enabled'];
  const keys = Object.keys(patch || {}).filter((k) => allow.includes(k));
  if (!keys.length) return 0;
  const sql = `UPDATE friend_feeds SET ${keys.map((k) => `${k}=?`).join(',')}, updated_at=? WHERE id=?`;
  await db.prepare(sql).bind(...keys.map((k) => patch[k]), bnNow(), id).run();
  return 1;
}
// 抓取结果回写：只放行这几个键，避免把任意字段写进库
export async function markFeedResult(db, id, patch) {
  await ensureFriendTables(db);
  const allow = ['name', 'site_url', 'avatar', 'last_fetch', 'last_status', 'last_error'];
  const keys = Object.keys(patch || {}).filter((k) => allow.includes(k));
  if (!keys.length) return 0;
  const sql = `UPDATE friend_feeds SET ${keys.map((k) => `${k}=?`).join(',')}, updated_at=? WHERE id=?`;
  await db.prepare(sql).bind(...keys.map((k) => patch[k]), bnNow(), id).run();
  return 1;
}
// 删订阅要连它的文章一起删，否则朋友列表没了、文章还挂在友圈里
export async function deleteFeed(db, id) {
  await ensureFriendTables(db);
  await db.prepare('DELETE FROM friend_posts WHERE feed_id=?').bind(id).run();
  await db.prepare('DELETE FROM friend_feeds WHERE id=?').bind(id).run();
}
// 抓回来的文章入库：同源同篇按 guid 覆盖（更新标题/摘要），不会重复堆
const KEEP_PER_FEED = 30;
export async function saveFeedItems(db, feedId, items, now) {
  await ensureFriendTables(db);
  const st = db.prepare(
    `INSERT INTO friend_posts(feed_id,guid,title,link,summary,author,published_at,fetched_at)
     VALUES(?,?,?,?,?,?,?,?)
     ON CONFLICT(feed_id,guid) DO UPDATE SET
       title=excluded.title, link=excluded.link, summary=excluded.summary,
       author=excluded.author, published_at=excluded.published_at, fetched_at=excluded.fetched_at`
  );
  for (const it of (items || []).slice(0, 20)) {
    await st.bind(feedId, it.guid, it.title, it.link, it.summary || '', it.author || '',
      it.published_at, now).run();
  }
  // 每个源只留最近的若干条，老文章自动淘汰，免得库无限长大
  await db.prepare(
    `DELETE FROM friend_posts WHERE feed_id=? AND id NOT IN
       (SELECT id FROM friend_posts WHERE feed_id=? ORDER BY published_at DESC, id DESC LIMIT ?)`
  ).bind(feedId, feedId, KEEP_PER_FEED).run();
  return (items || []).length;
}
// 前台友圈流：只取「启用中」的订阅；停用某个源，它的文章就一起消失
export async function listFriendPosts(db, { limit = 20, offset = 0 } = {}) {
  await ensureFriendTables(db);
  const r = await db.prepare(
    `SELECT fp.id,fp.title,fp.link,fp.summary,fp.author,fp.published_at,
       f.id AS feed_id, f.name AS feed_name, f.site_url AS feed_site, f.avatar AS feed_avatar
     FROM friend_posts fp JOIN friend_feeds f ON f.id = fp.feed_id
     WHERE f.enabled=1 ORDER BY fp.published_at DESC, fp.id DESC LIMIT ? OFFSET ?`
  ).bind(limit, offset).all();
  return r.results || [];
}
export async function countFriendPosts(db) {
  await ensureFriendTables(db);
  const r = await db.prepare(
    'SELECT COUNT(*) n FROM friend_posts fp JOIN friend_feeds f ON f.id=fp.feed_id WHERE f.enabled=1'
  ).first();
  return r ? r.n : 0;
}

// 独立页面（type='page'）：前台导航、站点地图与后台「页面」列表都走这里
export async function listPages(db, { status = 'published', inNav = false } = {}) {
  const r = await listPosts(db, { status, type: 'page', inNav, per: 200 });
  return r.items;
}

// ---------- 归档 / 全量导出（备份用） ----------
export async function archivePosts(db) {
  await ensurePostCols(db);
  const r = await db.prepare(
    // 带分类别名：永久链接用到 {category} 时归档页也要能拼出正确地址
    // 只归档文章：页面没有发布时间概念，混进来会变成一堆无日期条目
    `SELECT p.id,p.title,p.slug,p.published_at,c.slug AS cat_slug
      FROM posts p LEFT JOIN categories c ON c.id=p.category_id
      WHERE p.status='published' AND p.type='post' ORDER BY p.published_at DESC`).all();
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
    // 点赞进备份：pv_visitor 只是 UV 去重的临时明细，点赞是内容的一部分，丢了读者会察觉
    post_likes: await g('SELECT * FROM post_likes').catch(() => []),
    // 友圈订阅与抓回来的文章：都是博主一条条加出来的，换库时要能带走
    friend_feeds: await g('SELECT * FROM friend_feeds').catch(() => []),
    friend_posts: await g('SELECT * FROM friend_posts').catch(() => []),
  };
}
// 恢复：先清空再按原 id 回填（自动续接自增序列）
export async function restoreAll(db, data) {
  // 备份里可能带 type / in_nav 两列（新版本导出），目标库若没跑迁移要先补上，否则整批写入失败
  await ensurePostCols(db).catch(() => {});
  // 新版本导出的备份带 parent_id，目标库没跑 0006 迁移时要先补列，否则整批写入失败
  await ensureCatCols(db).catch(() => {});
  // 访问统计表可能还没建（老库），先确保存在再清空，否则 DELETE 会报 no such table
  await ensurePvTables(db).catch(() => {});
  await ensureLinkTable(db).catch(() => {});
  await ensureLikeTable(db).catch(() => {});
  await ensureFriendTables(db).catch(() => {});
  const clear = [
    'DELETE FROM post_tags', 'DELETE FROM comments', 'DELETE FROM posts',
    'DELETE FROM categories', 'DELETE FROM tags', 'DELETE FROM pv_daily', 'DELETE FROM links',
    'DELETE FROM post_likes',
    'DELETE FROM friend_posts', 'DELETE FROM friend_feeds',
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
  if (data.post_likes) await run(data.post_likes, 'post_likes');
  // 先订源后文章：friend_posts.feed_id 指向 friend_feeds.id
  if (data.friend_feeds) await run(data.friend_feeds, 'friend_feeds');
  if (data.friend_posts) await run(data.friend_posts, 'friend_posts');
  for (let i = 0; i < chunk.length; i += 40) await db.batch(chunk.slice(i, i + 40));
  return chunk.length;
}

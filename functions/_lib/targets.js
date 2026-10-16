// ============================================================
// 目标程序导出（Ver 0.6 ⑧ 第二步）：把本站内容按 Typecho / Z-Blog / WordPress
// 的表结构写出来，供迁移。
// ------------------------------------------------------------
// Wei 在 2026-10-15 定的四条（都体现在下面的代码里）：
//
// 1. **只数据，不建表**。理由不是偷懒：这三个程序都必须靠**它自己的安装程序**
//    写系统配置、建管理员账号，光把表灌进去是启动不了的。正确用法是
//    「先把目标程序正常装好 → 再导这份文件 → 把站上内容整批替换进去」，
//    所以文件里是 `DELETE` + `INSERT`，而不是 `DROP` + `CREATE`。
//
// 2. 表结构知识**内置在本文件**（表名/列名/字段含义），可以用**用户上传的**
//    目标程序安装脚本覆盖 —— 但覆盖只用来「学表名、学列名、认自定义前缀」，
//    那份 DDL 原文一律丢弃、绝不输出（与 ⑦ 的「不手抄 schema」同一条原则：
//    权威原文只用来对照，不用来当产物）。
//
// 3. 数据范围：内容（文章/分类/标签）+ 评论 + 少量站点配置。
//    **不搬账号**；友链只在目标程序**有原生表**时写（只有 WordPress 有 wp_links）；
//    友圈（friend_feeds / friend_posts）与图片（在 R2 里）搬不过去，文件头注明。
//
// 4. 每一条字段映射都**显式写死在下面的清单里**，不靠推断 —— 猜错一条就是死数据。
//    特别地：状态枚举、时间格式（我们是北京时间的 'YYYY-MM-DD HH:MM:SS'）、
//    ID 分配（Typecho 的分类与标签共用一张表，mid 必须全局唯一）都逐条对照过。
//
// ⚠️ 每种目标程序各自的「反直觉事实」都写在对应 build* 函数的注释里，
//    不搬到别处 —— 那些正是改代码时最容易改错的地方。
// ============================================================

import { insertStatements, literal, quoteIdent, tableColumns } from './sql.js';

// ---------- 时间 ----------
//
// ⚠️ 本站所有时间列都是**北京时间**字符串 'YYYY-MM-DD HH:MM:SS'（见 util.js 的 bnNow）。
//    Typecho / Z-Blog 要 unix 秒，WordPress 要 'YYYY-MM-DD HH:MM:SS' 且要同时给
//    本地时间和 GMT 时间。三种格式都从这里出，别在别处再写一遍解析。

const TS_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/;

// 北京时间字符串 → unix 秒
const unixOf = (s) => {
  const m = TS_RE.exec(String(s == null ? '' : s));
  if (!m) return 0;
  return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3], (+(m[4] || 0)) - 8, +(m[5] || 0), +(m[6] || 0)) / 1000);
};

// 北京时间字符串 → 'YYYY-MM-DD HH:MM:SS'（WordPress 的 *_date 用，原样即可）
const localOf = (s) => {
  const m = TS_RE.exec(String(s == null ? '' : s));
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4] || '00'}:${m[5] || '00'}:${m[6] || '00'}` : '1970-01-01 00:00:00';
};

// 北京时间字符串 → UTC 'YYYY-MM-DD HH:MM:SS'（WordPress 的 *_gmt 用）
const gmtOf = (s) => new Date(unixOf(s) * 1000).toISOString().slice(0, 19).replace('T', ' ');

// ---------- 状态映射 ----------
//
// 本站（见 db.js）：文章 status ∈ published | draft；评论 status ∈ approved | pending | trash。
// 三个程序各自的取值集合都不同，逐条显式映射 —— 不做「差不多就转小写」这种推断。

const WP_POST_STATUS = { published: 'publish', draft: 'draft' };
// Typecho 的评论状态是 approved / waiting / spam（没有 trash），回收站的评论归到 spam。
const TE_CMT_STATUS = { approved: 'approved', pending: 'waiting', trash: 'spam' };
// WordPress 的 comment_approved 恰好三种都有，可以原样保留。
const WP_CMT_STATUS = { approved: '1', pending: '0', trash: 'trash' };

const oneOf = (m, v, d) => m[v] || d;

// ---------- 源数据 ----------

const SRC = [
  ['settings', 'SELECT * FROM `settings`'],
  ['categories', 'SELECT * FROM `categories` ORDER BY id'],
  ['tags', 'SELECT * FROM `tags` ORDER BY id'],
  ['posts', 'SELECT * FROM `posts` ORDER BY id'],
  ['post_tags', 'SELECT * FROM `post_tags` ORDER BY post_id, tag_id'],
  ['comments', 'SELECT * FROM `comments` ORDER BY id'],
  ['links', 'SELECT * FROM `links` ORDER BY sort, id'],
];

// 取全站数据。迁移到别的博客程序（本文件）与导出静态站点（hexo.js）共用这一份 ——
// 谁也别再手抄一遍 SELECT 列表，漏一张表就是静默丢数据。
// （导出 .sql 那条线不走这里：它要的是 sqlite_master 的 DDL 原文，见 sql.js。）
export async function loadSource(db) {
  const all = async (sql) => {
    try { return ((await db.prepare(sql).all()).results) || []; } catch (e) { return []; }
  };
  const out = {};
  for (const [k, sql] of SRC) out[k] = await all(sql);
  const map = new Map();
  for (const r of out.settings) map.set(r.key, r.value);
  out.settingMap = map;
  // 每条评论的直属父评论（算 Z-Blog 的 comm_RootID 要用），以及每篇文章的评论数
  out.cmtById = new Map(out.comments.map((c) => [c.id, c]));
  out.cmtCount = new Map();
  for (const c of out.comments) out.cmtCount.set(c.post_id, (out.cmtCount.get(c.post_id) || 0) + 1);
  return out;
}

// 一条评论的「话题根评论」id：站内顶级评论返回 0，回复返回它所属根评论的 id。
// Z-Blog 的 comm_RootID 就是这个语义（0 = 自己就是根）。
function rootCommentId(c, byId) {
  let cur = c;
  let guard = 0;
  while (cur && cur.parent_id && guard++ < 128) {
    const p = byId.get(cur.parent_id);
    if (!p) break;
    cur = p;
  }
  return cur && cur.id !== c.id ? cur.id : 0;
}

// 表前缀：只接受「字母、数字、下划线」组成的串，避免用户填出注入式的怪东西，
// 也避免生成一个语法上不成立的标识符。
// 导出成 sanitizePrefix 供路由用（路由要拿它去替换用户上传脚本里的 %pre% 占位符）。
export const sanitizePrefix = (p) => {
  const s = String(p == null ? '' : p).trim();
  return /^[A-Za-z_][A-Za-z0-9_]{0,15}$/.test(s) ? s : '';
};

// 解析用户上传的目标程序建表脚本 → [{name, cols}]。
// ⚠️ 解析前必须先把 %pre% 替换成实际前缀：Z-Blog 官方建表脚本里表名就写作 `%pre%post`，
//    不替换的话列名正则会从 `%` 起头匹配不上，整张表被静默跳过。
export const parseSchema = (text, prefix) => tableColumns(String(text || '').replace(/%pre%/g, prefix || ''));

// ============================================================
// Typecho
// ============================================================
//
// ⚠️ 三条反直觉的事实（都对着 typecho/typecho 的 install/*.sql 与源码核过）：
//  ① **分类和标签共用 typecho_metas 一张表**，靠 `type` 列区分（category / tag）。
//     我们的 categories.id 与 tags.id 是各自从 1 开始的，直接搬会**撞 mid** ——
//     所以这里把两者合起来重新编号：分类在前、标签在后，mid 全局唯一。
//  ② **一篇文章的分类也是一条 relationship**（不是 contents 表上的列）。
//     所以 typecho_relationships 里既有「文章↔分类」也有「文章↔标签」，两者都要写。
//  ③ Typecho 原生吃 Markdown，正文取 `content_md`；`text` 列存的就是 Markdown 原文。
//     我们另一列 content_html 在这条链路上用不上（它给了 WordPress / Z-Blog）。
function buildTypecho(src, prefix) {
  const T = (n) => prefix + n;
  const tagOf = new Map(src.post_tags.map((r) => [r.post_id + ':' + r.tag_id, r]));
  const tagsOfPost = new Map();
  for (const r of src.post_tags) {
    if (!tagsOfPost.has(r.post_id)) tagsOfPost.set(r.post_id, []);
    tagsOfPost.get(r.post_id).push(r.tag_id);
  }
  const postsOfCat = new Map();
  for (const p of src.posts) {
    if (p.category_id == null) continue;
    postsOfCat.set(p.category_id, (postsOfCat.get(p.category_id) || 0) + 1);
  }
  const postsOfTag = new Map();
  for (const r of src.post_tags) postsOfTag.set(r.tag_id, (postsOfTag.get(r.tag_id) || 0) + 1);

  // ①②：mid 全局唯一
  const mid = new Map();
  let seq = 0;
  for (const c of src.categories) mid.set('c' + c.id, ++seq);
  for (const t of src.tags) mid.set('t' + t.id, ++seq);

  const metas = [];
  for (const c of src.categories) {
    metas.push({
      mid: mid.get('c' + c.id), name: c.name || '', slug: c.slug || '',
      type: 'category', description: c.description || '',
      count: postsOfCat.get(c.id) || 0, order: 0, parent: c.parent_id || 0,
    });
  }
  for (const t of src.tags) {
    metas.push({
      mid: mid.get('t' + t.id), name: t.name || '', slug: t.slug || '',
      type: 'tag', description: '', count: postsOfTag.get(t.id) || 0, order: 0, parent: 0,
    });
  }

  const allowComment = src.settingMap.get('allow_comments') === '1' ? '1' : '0';
  const contents = src.posts.map((p) => ({
    cid: p.id,
    title: p.title || '',
    slug: p.slug || '',
    created: unixOf(p.created_at),
    modified: unixOf(p.updated_at || p.created_at),
    text: p.content_md || '',
    order: 0,
    authorId: 1,                       // 不搬账号 → 统一挂到 1 号（目标站的默认管理员）
    template: '',
    type: p.type === 'page' ? 'page' : 'post',
    status: p.status === 'draft' ? 'draft' : 'publish',
    password: p.password || '',
    commentsNum: src.cmtCount.get(p.id) || 0,
    allowComment,
    allowPing: '1',
    allowFeed: '1',
    parent: 0,
  }));

  const relationships = [];
  for (const p of src.posts) {
    const cm = mid.get('c' + p.category_id);
    if (cm) relationships.push({ cid: p.id, mid: cm });
    for (const tid of (tagsOfPost.get(p.id) || [])) {
      const tm = mid.get('t' + tid);
      if (tm) relationships.push({ cid: p.id, mid: tm });
    }
  }

  const comments = src.comments.map((c) => ({
    coid: c.id,
    cid: c.post_id,
    created: unixOf(c.created_at),
    author: c.author || '',
    authorId: c.is_admin ? 1 : 0,      // 博主自己的回复挂到 1 号，前台会渲染成「作者」
    ownerId: 1,
    mail: c.email || '',
    url: c.website || '',
    ip: c.ip || '',
    agent: '',
    text: c.content || '',
    type: 'comment',
    status: oneOf(TE_CMT_STATUS, c.status, 'waiting'),
    parent: c.parent_id || 0,
  }));

  // 站点配置只动这两个键（Typecho 的 title / description 就是站点名与副标题）。
  // ⚠️ 绝不能整表 DELETE typecho_options —— 那会把主题、插件、路由等系统配置一起清掉，
  //    站点直接起不来。所以这条用的是「按 name 定点删」。
  const options = [];
  const title = String(src.settingMap.get('site_title') || '');
  const desc = String(src.settingMap.get('site_subtitle') || '');
  if (title) options.push({ name: 'title', user: 0, value: title });
  if (desc) options.push({ name: 'description', user: 0, value: desc });

  return [
    { key: 'relationships', name: T('relationships'), cols: ['cid', 'mid'], rows: relationships },
    { key: 'comments', name: T('comments'), cols: ['coid', 'cid', 'created', 'author', 'authorId', 'ownerId', 'mail', 'url', 'ip', 'agent', 'text', 'type', 'status', 'parent'], rows: comments },
    { key: 'contents', name: T('contents'), cols: ['cid', 'title', 'slug', 'created', 'modified', 'text', 'order', 'authorId', 'template', 'type', 'status', 'password', 'commentsNum', 'allowComment', 'allowPing', 'allowFeed', 'parent'], rows: contents },
    { key: 'metas', name: T('metas'), cols: ['mid', 'name', 'slug', 'type', 'description', 'count', 'order', 'parent'], rows: metas },
    {
      key: 'options', name: T('options'), cols: ['name', 'user', 'value'], rows: options,
      // 只删自己写的那几个键；一个键都不写时整表跳过（delFilter = null）。
      // ⚠️ 这里给的是**结构化的过滤条件**而不是 SQL 片段 —— 片段里写死反引号的话，
      //    PG 方言下 `user` 这个保留字就会因为没被双引号包住而报语法错。
      delFilter: options.length
        ? [{ col: 'name', values: ['title', 'description'] }, { col: 'user', values: [0] }]
        : null,
    },
  ];
}

// ============================================================
// Z-BlogPHP
// ============================================================
//
// ⚠️ 三条反直觉的事实（对着 zblogcn/zblogphp v1.7.5.3550 的源码核过）：
//  ① **log_Tag 存的既不是标签名也不是别名，而是 `{标签ID}` 的拼接串**。
//     判据是 zb_system/function/lib/base/post.php：
//       `$zbp->LoadTagsByIDString($this->Tag)`、`substr_count($this->Tag, '{')`
//     以及 LoadTagsByIDString() 自己 `str_replace('}{', '|')` 再拆。
//     所以这里输出的是 `{1}{7}` 这种串 —— 写成名字的话标签会全部丢失。
//     （推导过程：先试过「名字」和「别名」两种猜测，都无源码依据；这条有。）
//  ② Z-Blog 的表名带前缀占位符 `%pre%`（官方建表脚本里就是它），
//     我们直接按前缀拼名字，不生成 DDL，所以不涉及占位符替换。
//  ③ 状态是**数字**：log_Status 0=公开 1=草稿 2=审核；log_Type 0=文章 1=页面。
//     评论没有独立状态列，只有 comm_IsChecking（1 = 待审核）。
function buildZblog(src, prefix) {
  const T = (n) => prefix + n;
  const tagsOfPost = new Map();
  for (const r of src.post_tags) {
    if (!tagsOfPost.has(r.post_id)) tagsOfPost.set(r.post_id, []);
    tagsOfPost.get(r.post_id).push(r.tag_id);
  }
  const postsOfCat = new Map();
  for (const p of src.posts) {
    if (p.category_id == null) continue;
    postsOfCat.set(p.category_id, (postsOfCat.get(p.category_id) || 0) + 1);
  }
  const postsOfTag = new Map();
  for (const r of src.post_tags) postsOfTag.set(r.tag_id, (postsOfTag.get(r.tag_id) || 0) + 1);

  const post = src.posts.map((p) => ({
    log_ID: p.id,
    log_CateID: p.category_id == null ? 0 : p.category_id,
    log_AuthorID: 1,
    log_Tag: (tagsOfPost.get(p.id) || []).map((id) => '{' + id + '}').join(''),
    log_Status: p.status === 'draft' ? 1 : 0,
    log_Type: p.type === 'page' ? 1 : 0,
    log_Alias: p.slug || '',
    log_IsTop: p.pin ? 1 : 0,
    log_IsLock: 0,
    log_Title: p.title || '',
    log_Intro: p.excerpt || '',
    log_Content: p.content_html || '',   // Z-Blog 正文吃 HTML
    log_CreateTime: unixOf(p.created_at),
    log_PostTime: unixOf(p.published_at || p.created_at),
    log_UpdateTime: unixOf(p.updated_at || p.created_at),
    log_CommNums: src.cmtCount.get(p.id) || 0,
    log_ViewNums: p.view_count || 0,
    log_Template: '',
    log_Meta: '',
  }));

  const category = src.categories.map((c) => ({
    cate_ID: c.id,
    cate_Name: c.name || '',
    cate_Order: 0,
    cate_Type: 0,
    cate_Count: postsOfCat.get(c.id) || 0,
    cate_Alias: c.slug || '',
    cate_Group: '',
    cate_Intro: c.description || '',
    cate_RootID: 0,
    cate_ParentID: c.parent_id || 0,
    cate_CreateTime: unixOf(c.created_at),
    cate_PostTime: unixOf(c.created_at),
    cate_UpdateTime: unixOf(c.created_at),
    cate_Template: '',
    cate_Meta: '',
  }));

  const tag = src.tags.map((t) => ({
    tag_ID: t.id,
    tag_Name: t.name || '',
    tag_Order: 0,
    tag_Type: 0,
    tag_Count: postsOfTag.get(t.id) || 0,
    tag_Alias: t.slug || '',
    tag_Group: '',
    tag_Intro: '',
    tag_CreateTime: unixOf(t.created_at),
    tag_PostTime: unixOf(t.created_at),
    tag_UpdateTime: unixOf(t.created_at),
    tag_Template: '',
    tag_Meta: '',
  }));

  const comment = src.comments.map((c) => ({
    comm_ID: c.id,
    comm_LogID: c.post_id,
    comm_IsChecking: (c.status === 'pending' || c.status === 'trash') ? 1 : 0,
    comm_RootID: rootCommentId(c, src.cmtById),
    comm_ParentID: c.parent_id || 0,
    comm_AuthorID: c.is_admin ? 1 : 0,
    comm_Name: c.author || '',
    comm_Email: c.email || '',
    comm_HomePage: c.website || '',
    comm_Content: c.content || '',
    comm_PostTime: unixOf(c.created_at),
    comm_IP: c.ip || '',
    comm_Agent: '',
    comm_Meta: '',
  }));

  return [
    { key: 'comment', name: T('comment'), cols: ['comm_ID', 'comm_LogID', 'comm_IsChecking', 'comm_RootID', 'comm_ParentID', 'comm_AuthorID', 'comm_Name', 'comm_Email', 'comm_HomePage', 'comm_Content', 'comm_PostTime', 'comm_IP', 'comm_Agent', 'comm_Meta'], rows: comment },
    { key: 'post', name: T('post'), cols: ['log_ID', 'log_CateID', 'log_AuthorID', 'log_Tag', 'log_Status', 'log_Type', 'log_Alias', 'log_IsTop', 'log_IsLock', 'log_Title', 'log_Intro', 'log_Content', 'log_CreateTime', 'log_PostTime', 'log_UpdateTime', 'log_CommNums', 'log_ViewNums', 'log_Template', 'log_Meta'], rows: post },
    { key: 'category', name: T('category'), cols: ['cate_ID', 'cate_Name', 'cate_Order', 'cate_Type', 'cate_Count', 'cate_Alias', 'cate_Group', 'cate_Intro', 'cate_RootID', 'cate_ParentID', 'cate_CreateTime', 'cate_PostTime', 'cate_UpdateTime', 'cate_Template', 'cate_Meta'], rows: category },
    { key: 'tag', name: T('tag'), cols: ['tag_ID', 'tag_Name', 'tag_Order', 'tag_Type', 'tag_Count', 'tag_Alias', 'tag_Group', 'tag_Intro', 'tag_CreateTime', 'tag_PostTime', 'tag_UpdateTime', 'tag_Template', 'tag_Meta'], rows: tag },
  ];
}

// ============================================================
// WordPress
// ============================================================
//
// ⚠️ 四条反直觉的事实（对着 WordPress/WordPress 的 wp-admin/includes/schema.php 核过）：
//  ① **分类和标签是同一套表**：wp_terms（名字/别名）+ wp_term_taxonomy（taxonomy 列区分
//     category / post_tag）。跟 Typecho 一样要**全局重编号**，否则 term_id 撞车。
//     一篇文章的归属写进 wp_term_relationships（object_id = 文章 ID）。
//  ② 时间要写**两份**：post_date / comment_date 是站点本地时间，
//     post_date_gmt / comment_date_gmt 是 UTC。只写一份，后台列表会显示成 1970 年。
//  ③ `comment_approved` 是**字符串**：'1' 已通过、'0' 待审核、'trash' 回收站。
//     写成数字 1/0 在部分版本上会被当成「未通过」。
//  ④ 友链表叫 **wp_links**（新版后台已经不提供界面，但表仍在官方 schema 里）。
//     WordPress 是三个程序里唯一有原生友链表的，所以只有它写这块数据。
//  ⑤ WordPress 官方只支持 MySQL / MariaDB，所以它的 allow 里只有 mysql。
function buildWordpress(src, prefix) {
  const T = (n) => prefix + n;
  const guidBase = String(src.settingMap.get('site_url') || '').replace(/\/+$/, '');
  const openComments = src.settingMap.get('allow_comments') === '1' ? 'open' : 'closed';

  const tagsOfPost = new Map();
  for (const r of src.post_tags) {
    if (!tagsOfPost.has(r.post_id)) tagsOfPost.set(r.post_id, []);
    tagsOfPost.get(r.post_id).push(r.tag_id);
  }
  const postsOfCat = new Map();
  for (const p of src.posts) {
    if (p.category_id == null) continue;
    postsOfCat.set(p.category_id, (postsOfCat.get(p.category_id) || 0) + 1);
  }
  const postsOfTag = new Map();
  for (const r of src.post_tags) postsOfTag.set(r.tag_id, (postsOfTag.get(r.tag_id) || 0) + 1);

  // ①：term_id / term_taxonomy_id 全局唯一，分类在前、标签在后
  const tid = new Map();
  let seq = 0;
  for (const c of src.categories) tid.set('c' + c.id, ++seq);
  for (const t of src.tags) tid.set('t' + t.id, ++seq);

  const terms = [];
  const taxonomy = [];
  for (const c of src.categories) {
    const id = tid.get('c' + c.id);
    terms.push({ term_id: id, name: c.name || '', slug: c.slug || '', term_group: 0 });
    taxonomy.push({ term_taxonomy_id: id, term_id: id, taxonomy: 'category', description: c.description || '', parent: c.parent_id || 0, count: postsOfCat.get(c.id) || 0 });
  }
  for (const t of src.tags) {
    const id = tid.get('t' + t.id);
    terms.push({ term_id: id, name: t.name || '', slug: t.slug || '', term_group: 0 });
    taxonomy.push({ term_taxonomy_id: id, term_id: id, taxonomy: 'post_tag', description: '', parent: 0, count: postsOfTag.get(t.id) || 0 });
  }

  const posts = src.posts.map((p) => ({
    ID: p.id,
    post_author: 1,
    post_date: localOf(p.created_at),
    post_date_gmt: gmtOf(p.created_at),
    post_content: p.content_html || '',   // WordPress 正文吃 HTML
    post_title: p.title || '',
    post_excerpt: p.excerpt || '',
    post_status: oneOf(WP_POST_STATUS, p.status, 'publish'),
    comment_status: openComments,
    ping_status: 'open',
    post_password: p.password || '',
    post_name: p.slug || '',
    to_ping: '',
    pinged: '',
    post_modified: localOf(p.updated_at || p.created_at),
    post_modified_gmt: gmtOf(p.updated_at || p.created_at),
    post_content_filtered: '',
    post_parent: 0,
    // guid 对 WP 只是个不透明的唯一串（内部链接另由 rewrite 规则算），
    // 所以这里用站点地址拼 ?p=<id>，与 WP 自己的默认固定链接形态一致。
    guid: guidBase + '/?p=' + p.id,
    menu_order: 0,
    post_type: p.type === 'page' ? 'page' : 'post',
    post_mime_type: '',
    comment_count: src.cmtCount.get(p.id) || 0,
  }));

  const relationships = [];
  for (const p of src.posts) {
    const cm = tid.get('c' + p.category_id);
    if (cm) relationships.push({ object_id: p.id, term_taxonomy_id: cm, term_order: 0 });
    for (const t of (tagsOfPost.get(p.id) || [])) {
      const tm = tid.get('t' + t);
      if (tm) relationships.push({ object_id: p.id, term_taxonomy_id: tm, term_order: 0 });
    }
  }

  const comments = src.comments.map((c) => ({
    comment_ID: c.id,
    comment_post_ID: c.post_id,
    comment_author: c.author || '',
    comment_author_email: c.email || '',
    comment_author_url: c.website || '',
    comment_author_IP: c.ip || '',
    comment_date: localOf(c.created_at),
    comment_date_gmt: gmtOf(c.created_at),
    comment_content: c.content || '',
    comment_karma: 0,
    comment_approved: oneOf(WP_CMT_STATUS, c.status, '0'),
    comment_agent: '',
    comment_type: 'comment',
    comment_parent: c.parent_id || 0,
    user_id: c.is_admin ? 1 : 0,
  }));

  // ④：只有 WordPress 有原生友链表
  const links = src.links.map((l) => ({
    link_id: l.id,
    link_url: l.url || '',
    link_name: l.name || '',
    link_image: l.logo || '',
    link_target: '_blank',
    link_description: l.description || '',
    link_visible: l.status === 'approved' ? 'Y' : 'N',
    link_owner: 1,
    link_rating: 0,
    link_updated: localOf(l.updated_at || l.created_at),
    link_rel: '',
    link_notes: [l.contact, l.reason].filter(Boolean).join(' / '),
    link_rss: '',
  }));

  // 站点名与副标题：WP 的 option_name 就是 blogname / blogdescription（官方 schema 与
  // 后台「设置 → 常规」一一对应）。同样只按名字定点删这两个键，绝不整表清空。
  const options = [];
  const title = String(src.settingMap.get('site_title') || '');
  const desc = String(src.settingMap.get('site_subtitle') || '');
  if (title) options.push({ option_name: 'blogname', option_value: title, autoload: 'yes' });
  if (desc) options.push({ option_name: 'blogdescription', option_value: desc, autoload: 'yes' });

  return [
    { key: 'term_relationships', name: T('term_relationships'), cols: ['object_id', 'term_taxonomy_id', 'term_order'], rows: relationships },
    { key: 'comments', name: T('comments'), cols: ['comment_ID', 'comment_post_ID', 'comment_author', 'comment_author_email', 'comment_author_url', 'comment_author_IP', 'comment_date', 'comment_date_gmt', 'comment_content', 'comment_karma', 'comment_approved', 'comment_agent', 'comment_type', 'comment_parent', 'user_id'], rows: comments },
    { key: 'posts', name: T('posts'), cols: ['ID', 'post_author', 'post_date', 'post_date_gmt', 'post_content', 'post_title', 'post_excerpt', 'post_status', 'comment_status', 'ping_status', 'post_password', 'post_name', 'to_ping', 'pinged', 'post_modified', 'post_modified_gmt', 'post_content_filtered', 'post_parent', 'guid', 'menu_order', 'post_type', 'post_mime_type', 'comment_count'], rows: posts },
    { key: 'term_taxonomy', name: T('term_taxonomy'), cols: ['term_taxonomy_id', 'term_id', 'taxonomy', 'description', 'parent', 'count'], rows: taxonomy },
    { key: 'terms', name: T('terms'), cols: ['term_id', 'name', 'slug', 'term_group'], rows: terms },
    { key: 'links', name: T('links'), cols: ['link_id', 'link_url', 'link_name', 'link_image', 'link_target', 'link_description', 'link_visible', 'link_owner', 'link_rating', 'link_updated', 'link_rel', 'link_notes', 'link_rss'], rows: links },
    {
      key: 'options', name: T('options'), cols: ['option_name', 'option_value', 'autoload'], rows: options,
      delFilter: options.length
        ? [{ col: 'option_name', values: ['blogname', 'blogdescription'] }]
        : null,
    },
  ];
}

// 空表（占位）用的：commentmeta 在 WP 里是评论自定义字段，我们没这个概念。
// 留着它是为了在 DELETE 阶段把上一轮迁移留在里面的行清掉，保持可重复导入。

// ============================================================
// 登记表
// ============================================================

export const TARGETS = {
  typecho: {
    key: 'typecho',
    label: 'Typecho',
    allow: ['sqlite', 'mysql', 'pg'],
    prefix: 'typecho_',
    build: buildTypecho,
    notes: [
      '正文取本站的 Markdown 原文（Typecho 原生吃 Markdown）。',
      '分类与标签共用 typecho_metas，mid 已全局重编号；文章的分类也写成 relationships。',
      '站点名/副标题写进 typecho_options 的 title / description（只动这两个键）。',
      'Typecho 没有友链表（官方靠主题手写），本表的友链**未导出**。',
    ],
    skip: ['账号（Typecho 用户表未写）', '友链', '友圈', '图片（在 R2 上）'],
  },
  zblog: {
    key: 'zblog',
    label: 'Z-BlogPHP',
    allow: ['sqlite', 'mysql', 'pg'],
    prefix: 'zbp_',
    build: buildZblog,
    notes: [
      '正文取本站的 HTML（Z-Blog 正文吃 HTML）。',
      'log_Tag 按 Z-Blog 自己的格式写成 {标签ID} 拼接串（源码 LoadTagsByIDString 就是这个形态）。',
      '状态是数字：log_Status 0=公开 1=草稿；log_Type 0=文章 1=页面；评论只有 comm_IsChecking。',
    ],
    skip: ['账号', '友链', '友圈', '图片（在 R2 上）', '站点配置（Z-Blog 的 config 是 name/key 结构，没有权威文档可依，未写）'],
  },
  wordpress: {
    key: 'wordpress',
    label: 'WordPress',
    allow: ['mysql'],
    prefix: 'wp_',
    build: buildWordpress,
    notes: [
      '正文取本站的 HTML。',
      '分类与标签共用 wp_terms + wp_term_taxonomy，term_id 已全局重编号。',
      '时间同时写了本地时间与 *_gmt 两份（只写一份后台会显示成 1970 年）。',
      '友链写进 wp_links（WordPress 是三个程序里唯一有原生友链表的）。',
      '站点名/副标题写进 wp_options 的 blogname / blogdescription（只动这两个键）。',
    ],
    skip: ['账号', '友圈', '图片（在 R2 上）'],
  },
};

export const TARGET_KEYS = Object.keys(TARGETS);

// 别名的归一：全项目只此一份判定（同 normalizeFmt 的约定）。
const TARGET_ALIAS = {
  typecho: 'typecho',
  zblog: 'zblog', 'z-blog': 'zblog', zblogphp: 'zblog', zbp: 'zblog',
  wordpress: 'wordpress', wp: 'wordpress',
};

export const normalizeTarget = (t) => {
  const k = String(t == null ? '' : t).trim().toLowerCase();
  if (!k || k === 'default' || k === 'none' || k === '0') return '';
  return TARGET_ALIAS[k] || '';
};

// 给后台/路由用的能力表：哪个方言下允许哪些目标程序。
// ★ 后台的按钮禁用、下拉选项都由它驱动 —— 前端不许再手抄一份程序清单，
//   否则哪天加一个程序、或某个程序换了支持矩阵，界面就会静默地对不上（点下去才 400）。
// ★ skip 必须一起给出去：后台那句「不迁移：……」就是拿它渲染的。
//   第一版漏了它，页面上直接显示成「不迁移：。」（实测抓到的），用户会以为什么都迁过去了。
export const targetCapability = () => TARGET_KEYS.map((k) => ({
  key: k, label: TARGETS[k].label, allow: TARGETS[k].allow.slice(), prefix: TARGETS[k].prefix,
  skip: TARGETS[k].skip.slice(),
}));

// ============================================================
// 组装
// ============================================================

/**
 * 导出成目标程序可导入的「只数据」文件。
 * @param {object} db       D1 绑定
 * @param {string} fmt      方言（sqlite / mysql / pg，接受别名）
 * @param {string} targetKey normalizeTarget() 归一后的目标程序 key
 * @param {string} nowText  导出时间文本
 * @param {object} opts     { prefix?: string, override?: [{name, cols}] }
 * @returns {string} SQL 文本
 */
export async function dumpTarget(db, fmt, targetKey, nowText = '', opts = {}) {
  const T = TARGETS[targetKey];
  if (!T) throw new Error('未知的目标程序：' + targetKey);
  const f = fmt;                                   // 调用方已 normalizeFmt 过
  const q = (n) => quoteIdent(f, n);
  const prefix = sanitizePrefix(opts.prefix) || T.prefix;
  const src = await loadSource(db);
  const built = T.build(src, prefix);

  // 用上传的建表脚本覆盖「表名与列名」。只覆盖这两样，DDL 原文一律不输出。
  const warns = [];
  let tables = built;
  const ov = Array.isArray(opts.override) ? opts.override : null;
  if (ov && ov.length) {
    const used = new Set();
    tables = [];
    for (const t of built) {
      const hit = ov.find((o) => o.name === t.name)
        || ov.find((o) => !used.has(o.name) && o.name.endsWith(t.key));
      if (!hit) { warns.push('上传的建表脚本里找不到与 `' + t.key + '` 对应的表，该表整表跳过'); continue; }
      used.add(hit.name);
      const have = new Set(hit.cols);
      const missing = t.cols.filter((c) => !have.has(c));
      if (missing.length) warns.push(hit.name + ' 里没有 ' + missing.join('、') + '，这几列已省略');
      tables.push(Object.assign({}, t, { name: hit.name, cols: t.cols.filter((c) => have.has(c)) }));
    }
  }

  const counts = tables.map((t) => [t.name, t.rows.length]);
  const total = counts.reduce((a, b) => a + b[1], 0);
  // delFilter === null 表示「这个表这次没有要写的数据」，连 DELETE 都不发 ——
  // 对 options 这种表，发一条无 WHERE 的 DELETE 会把目标站整张配置表清空，站点直接起不来。
  // 既然不发语句，表清单里也不列它，免得看的人以为写过。
  const emitted = tables.filter((t) => t.delFilter !== null);
  // WHERE 从结构化条件拼出来，标识符一律过 quoteIdent —— 不在 builder 里手写 SQL 片段，
  // 否则反引号会把 PG 方言弄坏。
  const whereOf = (t) => (t.delFilter && t.delFilter.length
    ? ' WHERE ' + t.delFilter.map((f) => q(f.col) + ' IN (' + f.values.map((v) => literal(v)).join(', ') + ')').join(' AND ')
    : '');

  const head = [];
  head.push('-- 云尚博客 · 迁移到 ' + T.label + '（' + (f === 'pg' ? 'PostgreSQL' : f === 'mysql' ? 'MySQL' : 'SQLite') + '）');
  head.push('-- 导出时间：' + (nowText || ''));
  head.push('-- 表 ' + emitted.length + ' 张 / 记录 ' + total + ' 条');
  head.push('--');
  head.push('-- ⚠️ 这是**只数据**文件，不含建表语句。正确用法：');
  head.push('--    ① 先用 ' + T.label + ' 自己的安装程序把站装好（它会写系统配置、建管理员）；');
  head.push('--    ② 再用这份文件导入，把站上的内容整批替换进去。');
  head.push('--    ' + T.label + ' 必须靠它自己的安装程序才能启动，光灌数据是起不来的。');
  head.push('--');
  head.push('-- ⚠️ 每一段 INSERT 之前都有 DELETE，会**清空目标站对应表里现有的行**（内容、评论等会被替换）。');
  head.push('--    站点配置只按名字定点替换自己写的那几个键，不会清空整张配置表。');
  head.push('--');
  head.push('-- ✔ 已映射：' + T.notes.join('\n--            '));
  head.push('-- ✘ 未迁移：' + T.skip.join('、'));
  head.push('--');
  head.push('-- ⚠️ 本文件是明文全量数据（含未过审评论等），请当敏感文件保管。');
  if (warns.length) {
    head.push('-- ⚠️ 覆盖用建表脚本带来的提示：');
    for (const w of warns) head.push('--    · ' + w);
  }
  if (ov && ov.length) head.push('-- 表名与列名取自**你上传的**建表脚本，不是内置的默认表结构。');
  head.push('--');
  head.push('-- 表（按导入顺序）：');
  for (const [n, c] of counts) head.push('--   ' + n + '  (' + c + ' 条)');
  head.push('');

  const body = [];
  if (f === 'mysql') {
    body.push('SET NAMES utf8mb4;');
    body.push('SET FOREIGN_KEY_CHECKS=0;');
  } else if (f === 'pg') {
    body.push("SET client_encoding = 'UTF8';");
    body.push('SET standard_conforming_strings = on;');
  } else {
    body.push('PRAGMA foreign_keys=OFF;');
  }
  body.push('');
  body.push('BEGIN TRANSACTION;');
  body.push('');

  for (const t of emitted) {
    body.push('DELETE FROM ' + q(t.name) + whereOf(t) + ';');
    for (const st of insertStatements(t.name, t.cols, t.rows, f)) body.push(st);
    body.push('');
  }

  body.push('COMMIT;');
  if (f === 'mysql') { body.push(''); body.push('SET FOREIGN_KEY_CHECKS=1;'); }
  body.push('');

  return head.join('\n') + '\n' + body.join('\n');
}

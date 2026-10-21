// ============================================================
// 目标程序导出（Ver 0.6 ⑧ 第二步）：把本站内容按 Typecho / Z-Blog / WordPress
// 的表结构写出来，供迁移。
// ------------------------------------------------------------
// Wei 在 2026-10-15 定的四条（都体现在下面的代码里）：
//
// 1. **只数据，不建表**。理由不是偷懒：这三个程序都必须靠**它自己的安装程序**
//    写系统配置、建管理员账号，光把表灌进去是启动不了的。正确用法是
//    「先把目标程序正常装好 → 再导这份文件 → 把站上内容整批替换进去」，
//    所以文件里是 `INSERT`，而不是 `DROP` + `CREATE`。**目标站已经有的行怎么办**由调用方
//    传 `mode` 决定，三档互斥、默认 `append`（只追加）—— 2026-10-16 Wei 定的：
//      · append：一条 `DELETE` 都不发、ID 也不动。空站装好就导；已有内容的站会撞主键。
//      · shift ：我们内容的 ID 整体加一个偏移（默认 100000）**以新编号追加**，
//                目标站原有的行一行都不动，也就不存在主键冲突。
//      · wipe  ：每段 INSERT 前加 `DELETE` 清空目标站对应表（整批替换，不可逆）。
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

import { insertStatements, literal, quoteIdent, setvalStatement, tableColumns } from './sql.js';

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
  ['posts', "SELECT * FROM `posts` WHERE deleted_at IS NULL OR deleted_at='' ORDER BY id"],
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
  // 老库还没跑 0014 时上面的 deleted_at 条件会让整条查询失败（all() 吞异常返回空数组），
  // 回退成不过滤 —— 宁可多搬几篇，也绝不能导出一个 0 篇文章的空文件。
  if (!out.posts.length) out.posts = await all('SELECT * FROM `posts` ORDER BY id');
  // 回收站里的文章/页面不参与迁移与静态导出：它们的状态可能仍是 published，原样搬过去
  // 会在目标站真的上线。它们的评论与标签关联一并剔除，否则目标站会多出指向不存在文章的
  // 孤儿行（Z-Blog 的评论数也会对不上）。
  const kept = new Set(out.posts.map((p) => p.id));
  out.post_tags = out.post_tags.filter((r) => kept.has(r.post_id));
  out.comments = out.comments.filter((c) => kept.has(c.post_id));
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

// ---------- 目标站已有的行怎么处理（2026-10-16）----------
//
// ★ 三档是**互斥**的，所以用一个枚举而不是两个各自独立的开关。两个独立开关能表达出
//   「既平移又清空」这种自相矛盾的状态，然后就得再定一套「谁优先」的规矩 ——
//   而那正是最容易改错、也最难在界面上说清的地方。
export const TARGET_MODES = ['append', 'shift', 'wipe'];
const MODE_ALIAS = {
  append: 'append', add: 'append', only: 'append', keep: 'append',
  shift: 'shift', offset: 'shift', renumber: 'shift',
  wipe: 'wipe', clear: 'wipe', truncate: 'wipe', replace: 'wipe',
};
// 归一（同 normalizeFmt / normalizeTarget 的约定：全项目只此一份判定）。
// ★ 认不出来的值一律回落 `append` —— 也就是「不动目标站数据」那一侧。
export const normalizeMode = (m) => {
  const s = String(m == null ? '' : m).trim().toLowerCase();
  return MODE_ALIAS[s] || 'append';
};

// ID 平移的偏移量，默认 100000：目标站几乎不可能已经有人把内容做到十万条，
// 撞上的概率可以忽略；又不至于大到文件名/后台里看着别扭。
export const DEFAULT_OFFSET = 100000;
// ★ 判据从严：只接受 1..999999999 的**整数**。0 / 空 / 负数 / 小数 / 'abc' / 超大数
//   一律回落默认值 —— **绝不能静默按 0 处理**：按 0 就等于「没平移」，用户以为躲开了
//   主键冲突、实际照样撞，而文件头还会写着「已平移」。
export const normalizeOffset = (v) => {
  const n = Number(String(v == null ? '' : v).trim());
  return Number.isInteger(n) && n >= 1 && n <= 999999999 ? n : DEFAULT_OFFSET;
};

// 平移一个 id。★ 有三类值**绝不能**平移：
//   ① **0 / null** —— 三个程序里 0 都是「无父级 / 游客」的哨兵值，平移它就会把评论挂到
//      一个不存在的父级上、把文章挂到不存在的分类上（导入能过，前台全乱）。
//   ② 指向**目标站账号**的列 —— Typecho 的 authorId / ownerId、Z-Blog 的 log_AuthorID /
//      comm_AuthorID、WordPress 的 post_author / user_id / link_owner。它们指的是
//      「目标站安装程序建出来的那个管理员」，跟我们的 id 没有任何关系。所以这些列在
//      下面的映射里一律写死 1 / 0，**不经过这个函数**。
//   ③ 目标站自己表里的配置值（如 wp_options 的 default_category）—— 我们本来就不写。
const shiftId = (off, v) => {
  const n = Number(v);
  if (!off || !n) return v == null ? 0 : v;
  return n + off;
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
function buildTypecho(src, prefix, off = 0) {
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

  // ①②：mid 全局唯一。★ 重编号从 `off + 1` 起：off=0 时与原来完全一致（1 起），
  //    off>0 时整段搬到「目标站不可能用到的编号」上，这才叫平移。
  const mid = new Map();
  let seq = off;
  for (const c of src.categories) mid.set('c' + c.id, ++seq);
  for (const t of src.tags) mid.set('t' + t.id, ++seq);

  const metas = [];
  for (const c of src.categories) {
    metas.push({
      mid: mid.get('c' + c.id), name: c.name || '', slug: c.slug || '',
      type: 'category', description: c.description || '',
      // ★ 父分类也必须过 mid 映射。原来直接写 `parent_id` 只是**碰巧**成立（分类先编号、
      //   恰好 id 与 mid 一一相等），一平移 offset 就立刻错位到别的分类上。
      count: postsOfCat.get(c.id) || 0, order: 0,
      parent: c.parent_id ? (mid.get('c' + c.parent_id) || 0) : 0,
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
    cid: shiftId(off, p.id),
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
    if (cm) relationships.push({ cid: shiftId(off, p.id), mid: cm });
    for (const tid of (tagsOfPost.get(p.id) || [])) {
      const tm = mid.get('t' + tid);
      if (tm) relationships.push({ cid: shiftId(off, p.id), mid: tm });
    }
  }

  const comments = src.comments.map((c) => ({
    coid: shiftId(off, c.id),
    cid: shiftId(off, c.post_id),
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
    parent: shiftId(off, c.parent_id),
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
function buildZblog(src, prefix, off = 0) {
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
    log_ID: shiftId(off, p.id),
    log_CateID: p.category_id == null ? 0 : shiftId(off, p.category_id),
    log_AuthorID: 1,                   // ← 目标站的管理员，不是我们的 id，绝不平移
    // ★ log_Tag 里存的是 `{标签ID}` 拼接串（见上面①），所以它**是外键、必须跟着平移**。
    //   它是唯一一处「id 藏在字符串里」的地方 —— 漏掉它，导入不报错，但所有标签会指向
    //   一堆不存在的标签ID（Z-Blog 直接判定为「没有标签」），静默丢数据。
    log_Tag: (tagsOfPost.get(p.id) || []).map((id) => '{' + shiftId(off, id) + '}').join(''),
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
    cate_ID: shiftId(off, c.id),
    cate_Name: c.name || '',
    cate_Order: 0,
    cate_Type: 0,
    cate_Count: postsOfCat.get(c.id) || 0,
    cate_Alias: c.slug || '',
    cate_Group: '',
    cate_Intro: c.description || '',
    cate_RootID: 0,
    cate_ParentID: shiftId(off, c.parent_id),
    cate_CreateTime: unixOf(c.created_at),
    cate_PostTime: unixOf(c.created_at),
    cate_UpdateTime: unixOf(c.created_at),
    cate_Template: '',
    cate_Meta: '',
  }));

  const tag = src.tags.map((t) => ({
    tag_ID: shiftId(off, t.id),
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
    comm_ID: shiftId(off, c.id),
    comm_LogID: shiftId(off, c.post_id),
    comm_IsChecking: (c.status === 'pending' || c.status === 'trash') ? 1 : 0,
    // 话题根评论（0 = 自己就是根）：must 走后一个参数，0 不许被平移
    comm_RootID: shiftId(off, rootCommentId(c, src.cmtById)),
    comm_ParentID: shiftId(off, c.parent_id),
    comm_AuthorID: c.is_admin ? 1 : 0,   // ← 同上：目标站账号，不平移
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
function buildWordpress(src, prefix, off = 0) {
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

  // ①：term_id / term_taxonomy_id 全局唯一，分类在前、标签在后。
  // ★ 与 Typecho 的 mid 同一个道理：从 `off + 1` 起，off=0 时与原来完全一致。
  const tid = new Map();
  let seq = off;
  for (const c of src.categories) tid.set('c' + c.id, ++seq);
  for (const t of src.tags) tid.set('t' + t.id, ++seq);

  const terms = [];
  const taxonomy = [];
  for (const c of src.categories) {
    const id = tid.get('c' + c.id);
    terms.push({ term_id: id, name: c.name || '', slug: c.slug || '', term_group: 0 });
    // 父分类取的是**平移后的** term_id（原来直接写 parent_id 只是碰巧对，一平移就错位）
    taxonomy.push({ term_taxonomy_id: id, term_id: id, taxonomy: 'category', description: c.description || '', parent: c.parent_id ? (tid.get('c' + c.parent_id) || 0) : 0, count: postsOfCat.get(c.id) || 0 });
  }
  for (const t of src.tags) {
    const id = tid.get('t' + t.id);
    terms.push({ term_id: id, name: t.name || '', slug: t.slug || '', term_group: 0 });
    taxonomy.push({ term_taxonomy_id: id, term_id: id, taxonomy: 'post_tag', description: '', parent: 0, count: postsOfTag.get(t.id) || 0 });
  }

  const posts = src.posts.map((p) => ({
    ID: shiftId(off, p.id),
    post_author: 1,                    // ← 目标站的 1 号用户，不平移
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
    // ★ guid 里的 id 必须跟着平移：它得指回**这份文件里真正写进去的那个 ID**，
    //   否则 WP 会认为每篇文章的 guid 都没见过（重复导入时判定失效）。
    guid: guidBase + '/?p=' + shiftId(off, p.id),
    menu_order: 0,
    post_type: p.type === 'page' ? 'page' : 'post',
    post_mime_type: '',
    comment_count: src.cmtCount.get(p.id) || 0,
  }));

  const relationships = [];
  for (const p of src.posts) {
    const cm = tid.get('c' + p.category_id);
    if (cm) relationships.push({ object_id: shiftId(off, p.id), term_taxonomy_id: cm, term_order: 0 });
    for (const t of (tagsOfPost.get(p.id) || [])) {
      const tm = tid.get('t' + t);
      if (tm) relationships.push({ object_id: shiftId(off, p.id), term_taxonomy_id: tm, term_order: 0 });
    }
  }

  const comments = src.comments.map((c) => ({
    comment_ID: shiftId(off, c.id),
    comment_post_ID: shiftId(off, c.post_id),
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
    comment_parent: shiftId(off, c.parent_id),
    user_id: c.is_admin ? 1 : 0,       // ← 目标站的 1 号用户，不平移
  }));

  // ④：只有 WordPress 有原生友链表
  const links = src.links.map((l) => ({
    link_id: shiftId(off, l.id),
    link_url: l.url || '',
    link_name: l.name || '',
    link_image: l.logo || '',
    link_target: '_blank',
    link_description: l.description || '',
    link_visible: l.status === 'approved' ? 'Y' : 'N',
    link_owner: 1,                     // ← 目标站的 1 号用户，不平移
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

// 每个目标程序里**自增主键**的列（内部表 key → 列名）。PG 形态的文件末尾要按它逐个补 setval。
//    原理：PG 的序列（SERIAL / IDENTITY）**不会**因为 INSERT 显式写了 id 而前进，
//    不补的话导完之后目标站自己在后台新建第一条内容就撞主键。
//    SQLite 有 sqlite_sequence 会自动跟上、MySQL 的 AUTO_INCREMENT 在插入显式值时也会自动抬高
//    ——**只有 PG 需要**（与全库导出那条线同一个道理，见 sql.js 的 setvalStatement）。
//    ⚠️ 只列自增的：Typecho 的 relationships（复合主键）、Typecho options、WP options /
//    term_relationships 都不是自增、没有序列，写了反而会在目标站上报错。
//    ⚠️ 用 key 而不是表名查 —— 用户上传的建表脚本可能把表名换掉，key 才是稳定内部名。
const SERIAL_PK = {
  typecho: { contents: 'cid', metas: 'mid', comments: 'coid' },
  zblog: { post: 'log_ID', category: 'cate_ID', tag: 'tag_ID', comment: 'comm_ID' },
  wordpress: {
    posts: 'ID', terms: 'term_id', term_taxonomy: 'term_taxonomy_id',
    comments: 'comment_ID', links: 'link_id',
  },
};

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
 * @param {object} opts     { prefix?: string, override?: [{name, cols}], mode?: string, offset?: number }
 *                          mode: append（默认，只追加） | shift（ID 平移后追加） | wipe（先清空）
 * @returns {string} SQL 文本
 */
export async function dumpTarget(db, fmt, targetKey, nowText = '', opts = {}) {
  const T = TARGETS[targetKey];
  if (!T) throw new Error('未知的目标程序：' + targetKey);
  const f = fmt;                                   // 调用方已 normalizeFmt 过
  const q = (n) => quoteIdent(f, n);
  const prefix = sanitizePrefix(opts.prefix) || T.prefix;
  // ★ 目标站已有的行怎么处理：三档互斥，默认 `append`（一条 DELETE 都不发、ID 也不动）。
  //   认不出的值一律回落 append —— 落在「不动目标站数据」那一侧（同 wipe 那次的教训：
  //   默认值即安全承诺）。
  const mode = normalizeMode(opts.mode);
  // ★ offset 只在 shift 档读；另外两档一律按 0（不平移），免得留下「以为平移了」的假象。
  const offset = mode === 'shift' ? normalizeOffset(opts.offset) : 0;
  const src = await loadSource(db);
  const built = T.build(src, prefix, offset);

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

  // ★★ PG 独有的收尾：重设自增序列（2026-10-16 补的一处隐患）。
  //    前面所有 INSERT 都把 id 显式写了进去，而 PG 的序列不会因此前进 —— 导完之后
  //    目标站自己在后台新建第一条内容就会撞主键。这跟 wipe / shift / append 无关，
  //    三档都有这个毛病，所以是**无条件**补（只看方言是不是 pg）。
  //    ★ 值用 `SELECT MAX(pk) FROM 表` 在**导入时**现算，不是导出时写死：
  //      append / shift 两档下目标站原有的行 id 可能比我们的更大，写死我们的最大值
  //      会把序列往回拨 —— 导出时根本无从得知目标站的状态，只有目标站自己算得准。
  //    ★ 两个不发的情形：主键列被上传的建表脚本过滤掉了、或这张表这次没有数据
  //      —— 这两种情况下我们没往那个 id 列里写过任何数字，序列保持原样才是对的。
  const serialPk = SERIAL_PK[targetKey] || {};
  const seqs = f === 'pg'
    ? emitted.filter((t) => serialPk[t.key] && t.cols.includes(serialPk[t.key]) && t.rows.length)
    : [];

  const head = [];
  head.push('-- 云尚博客 · 迁移到 ' + T.label + '（' + (f === 'pg' ? 'PostgreSQL' : f === 'mysql' ? 'MySQL' : 'SQLite') + '）');
  head.push('-- 导出时间：' + (nowText || ''));
  head.push('-- 表 ' + emitted.length + ' 张 / 记录 ' + total + ' 条');
  head.push('--');
  head.push('-- ⚠️ 这是**只数据**文件，不含建表语句。正确用法：');
  head.push('--    ① 先用 ' + T.label + ' 自己的安装程序把站装好（它会写系统配置、建管理员）；');
  head.push('--    ② 再用这份文件导入。');
  head.push('--    ' + T.label + ' 必须靠它自己的安装程序才能启动，光灌数据是起不来的。');
  head.push('--');
  // ★ 三档的头部口径必须**各不相同**，而且要和真正生成的语句对得上：
  //   写死一句的话，用户就会按「没清空」的样子去读一份带着 DELETE 的文件（或反过来）。
  //   这三段文案与后台 #t-note 是同一套说辞，改一处必须改另一处。
  if (mode === 'wipe') {
    head.push('-- ⚠️ 处理方式：**先清空目标站对应表** —— 每一段 INSERT 之前都有 DELETE。');
    head.push('--    目标站对应表里现有的行会被清掉（内容、评论等整批替换）。');
    head.push('--    站点配置只按名字定点替换自己写的那几个键，不会清空整张配置表。');
  } else if (mode === 'shift') {
    head.push('-- ⚠️ 处理方式：**ID 平移后追加** —— 不清空、也不覆盖任何东西。');
    head.push('--    我们内容的 ID 整体加了 ' + offset + '：本站 1 号内容在这份文件里是 ' + (1 + offset) + ' 号。');
    head.push('--    分类与标签、评论、以及文章与分类/标签的关联（含 Z-Blog 的 {标签ID} 串）都跟着一起平移，');
    head.push('--    指向**账号**的列（作者、评论人）保持 1 / 0 不动 —— 它指的是目标站装出来的那个管理员。');
    head.push('--    目标站原有的行**一行都不动**，所以不会撞主键、导入也不会中途报错。');
    head.push('--    （目标站后台里看到的是新编号。若目标站是刚装好的空站，用默认的「只追加」更好，');
    head.push('--      平移会白白留下一段空号。）');
  } else {
    head.push('-- ⚠️ 处理方式：**只追加** —— 不含 DELETE，ID 也不动，目标站里已有的行一律留着。');
    head.push('--    所以导进一个「已经装好、并且已经有内容」的站时，撞上已有的主键（默认分类、示例文章、');
    head.push('--    同名配置键……）就会在导入中途报错停下。要避免请重新导一份，选「用新 ID 追加」或「先清空」。');
  }
  head.push('--');
  if (seqs.length) {
    head.push('-- ✔ 文件末尾按表补了 setval 重设自增序列（PG 独有的一步）：PG 的序列不会因为上面');
    head.push('--    显式插入了 id 而前进，不补的话导入后目标站自己新建的第一条内容就会撞主键。');
    head.push('--    它取的是**导入时**该表的最大 id，所以三档都适用（只追加时目标站原有更大的 id 也算进去）。');
  }
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
    // ★ 只有 wipe 档才发 DELETE。append 与 shift 都不许碰目标站已经有的行 ——
    //   尤其 shift：它的全部意义就是「一行不删也能导进去」，这里多发一条就白做了。
    if (mode === 'wipe') body.push('DELETE FROM ' + q(t.name) + whereOf(t) + ';');
    for (const st of insertStatements(t.name, t.cols, t.rows, f)) body.push(st);
    body.push('');
  }

  // ★ PG 独有：把每张自增表的序列拨到「导入时该表的最大 id」。
  //   排在数据之后、COMMIT 之前（与全库导出那条线同一个位置）。setval 本身是非事务的
  //   —— 事务回滚不会撤销它，但它取的值永远是当时真实的最大 id，所以重复执行、
  //   以及导入中途失败都不会把序列弄坏。
  //   `guard` 见 sql.js：目标程序自己建的表万一主键没序列（改了 UUID / 复合主键），
  //   加了 guard 之后是「这条不执行」，而不是 setval(NULL::regclass) 把导入卡死在这一行。
  if (seqs.length) {
    body.push('-- 重设自增序列（PG 独有）：不补的话，导入后目标站新建的第一条内容会撞主键。');
    for (const s of seqs) body.push(setvalStatement(s.name, serialPk[s.key], { guard: true }));
    body.push('');
  }

  body.push('COMMIT;');
  if (f === 'mysql') { body.push(''); body.push('SET FOREIGN_KEY_CHECKS=1;'); }
  body.push('');

  return head.join('\n') + '\n' + body.join('\n');
}

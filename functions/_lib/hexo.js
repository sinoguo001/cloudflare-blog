// 导出为「静态站点」用的 Markdown 压缩包（Ver 0.6 ⑧）
//
// 目标：把站内内容整批搬到任意静态博客生成器（Hexo / Hugo / Astro / 11ty …）重新生成，
// 产物按 **Hexo 惯例** 组织，因为它是中文圈静态博客里最通用的一套约定。
//
// 反直觉点，逐条写在这里免得后人踩：
//  · 正文直接用 posts.content_md —— 编辑器本来就是 Markdown 原生存的，**不需要任何转换**。
//  · 数据库里的时间戳是**北京时间字符串**（db.js 的 bnNow 是 Date.now()+8h 再切 ISO），
//    所以直接切前 19 个字符就是对的。**绝对不要过 new Date()** —— 字符串不带偏移标记，
//    会被当成 UTC 再换算一次，整份导出件的日期集体差 8 小时。
//  · 正文里的图片是**站内路径** /media/xxx。搬到别的站，要么改写成线上绝对地址，
//    要么把图一起打包进 zip（此时链接保持 /media/xxx 不动，靠「图片也放到站点根 media/ 下」对上）。
//  · 早期上传接口会多拼一段 media，历史文章里存的是 /media/media/xxx —— 取 R2 对象前
//    必须按 [[path]].js 里同一条规则归一，否则去 R2 拿的是不存在的键。
//  · 草稿、加密文章（password 非空）、未过审与回收站评论**不导出**：
//    草稿没定稿，加密文章导出来就失去保护了（这两个是「导出去会出事」而非「忘了导」）。

import { loadSource } from './targets.js';
import { postUrl, pageUrl } from './util.js';

// 勾选「连同图片一起打包」时的护栏。Workers 的内存与响应体都有上限，
// 不设限就是拿一个 500 收场；宁可当场报错说清楚，也不给一个半截包。
export const MEDIA_MAX_FILES = 300;
// 30MB 而不是更大：打包时「所有图片的字节」与「拼好的 zip」会同时在内存里，
// 峰值差不多是两倍 —— Workers 的内存上限 128MB，卡在 30MB 才留得住余量。
// 真超了会明确报错让用户取消勾选，不会给一个半截包。
export const MEDIA_MAX_BYTES = 30 * 1024 * 1024;

// 正文/封面里的站内媒体路径。尾部把 `)` `"` `<` 和常见中英文标点都排除掉 ——
// 少了这一段 `![图](/media/a.jpg)` 会把右括号一起吞进 URL。
const MEDIA_RE = /\/media\/[^\s)"'<>，。；：！？（）【】《》、,;]+/g;

const isoDate = (s) => String(s || '').slice(0, 10);
// 一个反斜杠字符。用常量而不是字面量：下面要往字符串里塞转义符，直接写反斜杠
// 会和「文件本身的转义」缠在一起，读的人没法一眼看出最终到底生成了几个。
const BS = String.fromCharCode(92);

// YAML 双引号标量。标题里出现引号、冒号、井号、以短横开头，都会让裸标量解析出错，
// 统一加引号 + 转义，代价只有两个字符。反斜杠必须**先**转 —— 否则会把后面补进去的
// 转义符再转一遍。换行折成 \n 转义，保证 front matter 始终是逐行可读的。
const yamlStr = (v) => '"' + String(v ?? '')
  .split(BS).join(BS + BS)
  .split('"').join(BS + '"')
  .replace(/\r?\n/g, BS + 'n') + '"';

// 数据库里就是 'YYYY-MM-DD HH:MM:SS' 的北京时间，切下来直接用（见文件头说明）。
function fmDate(s) {
  const t = String(s || '').replace('T', ' ').trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(t)) return t;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t + ' 00:00:00';
  return '';
}

// 文件名安全化：slug 在库里有 UNIQUE 约束，但 slug 里可能带空格或中文，
// 而 `/` 与 Windows 保留字符会让解压端出错。
export function safeFileName(s) {
  const out = String(s || '').replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '');
  return out || 'untitled';
}

// 分类名链：categories 支持二级（parent_id），Hexo 的多级分类是
//   categories:
//     - 父
//     - 子
// 所以这里要从当前分类一路往上溯。guard 防住脏数据里的环。
function catPath(byId, id) {
  const out = [];
  let cur = byId.get(id);
  let guard = 0;
  while (cur && guard++ < 20) {
    out.unshift(String(cur.name || ''));
    cur = byId.get(cur.parent_id);
  }
  return out.filter(Boolean);
}

/**
 * 生成 Hexo 风格的 front matter（含首尾 `---`）。
 * 单独导出成函数是为了测试能直接盯着字段，不用先把整包 zip 拆开。
 */
export function hexoFrontMatter(p) {
  const L = ['---'];
  L.push('title: ' + yamlStr(p.title));
  const d = fmDate(p.date);
  if (d) L.push('date: ' + d);
  const u = fmDate(p.updated);
  // updated 与 date 相同就不写 —— 省一行噪音，Hexo 会自己回落到 date
  if (u && u !== d) L.push('updated: ' + u);
  if (p.categories && p.categories.length) {
    L.push('categories:');
    for (const c of p.categories) L.push('  - ' + yamlStr(c));
  }
  if (p.tags && p.tags.length) {
    L.push('tags:');
    for (const t of p.tags) L.push('  - ' + yamlStr(t));
  }
  if (p.description) L.push('description: ' + yamlStr(p.description));
  if (p.cover) L.push('cover: ' + p.cover);
  if (p.isPage) L.push('layout: page');
  L.push('---');
  return L.join('\n');
}

/**
 * 正文里的站内媒体改写。
 * base 为空 → 原样保留（打包模式，图片靠站点根的 media/ 目录对上）；
 * 给了 base（如 https://blog.100825.xyz）→ 改写成绝对地址（不打包模式）。
 * 返回值里带上用到过的路径，供打包时决定要抓哪些对象。
 */
export function rewriteMedia(text, base) {
  const used = [];
  const pre = base ? String(base).replace(/\/+$/, '') : '';
  const out = String(text || '').replace(MEDIA_RE, (u) => {
    used.push(u);
    return pre ? pre + u : u;
  });
  return { text: out, used };
}

// 与 [[path]].js 里 /media/ 分支同一条归一化规则（历史数据里 /media/media/xxx 很常见）。
export function mediaKeyOf(u) {
  const segs = String(u || '').replace(/^\/+/, '').split(/[?#]/)[0].split('/').filter(Boolean);
  if (segs[0] === 'media' && segs[1] === 'media') segs.shift();
  return segs.join('/');
}

/**
 * 打包整个站点的静态版本。
 * @param {D1Database} db
 * @param {{origin?:string, withMedia?:boolean, r2?:object, nowText?:string}} opts
 * @returns {Promise<{files:{name:string,data:Uint8Array|string}[], stats:object}>}
 */
export async function dumpHexo(db, opts = {}) {
  const src = await loadSource(db);
  const origin = String(opts.origin || '').replace(/\/+$/, '');
  const withMedia = !!opts.withMedia;
  const sm = src.settingMap || new Map();

  const stats = {
    posts: 0, pages: 0, comments: 0, commentsIn: 0,
    mediaRefs: 0,     // 正文与封面里引用到的媒体个数（不论这次有没有一起打包）
    media: 0,         // 真正打进包里的个数
    mediaBytes: 0,
    skipped: { unpublished: 0, locked: 0, noBody: 0, pendingComments: 0 },
    missingMedia: [],
  };

  const catById = new Map(src.categories.map((c) => [c.id, c]));
  const tagById = new Map(src.tags.map((t) => [t.id, t]));
  const tagsByPost = new Map();
  for (const pt of src.post_tags) {
    if (!tagsByPost.has(pt.post_id)) tagsByPost.set(pt.post_id, []);
    const t = tagById.get(pt.tag_id);
    if (t) tagsByPost.get(pt.post_id).push(String(t.name || ''));
  }

  // 先筛出要导的文章：已发布 + 有正文。跳过的一律计数上报，不做静默丢弃。
  const picked = [];
  for (const p of src.posts) {
    // 未发布的（草稿等）不导：没定稿的东西跟着搬走只会让人误会
    if (p.status !== 'published') { stats.skipped.unpublished++; continue; }
    if (String(p.password || '')) { stats.skipped.locked++; continue; }
    // 正文存在 content_html 里而 content_md 是空的那种老数据，导入静态站会得到一篇空文，
    // 与其生成一个看起来正常其实没内容的文件，不如跳过并如实报数
    if (!String(p.content_md || '').trim()) { stats.skipped.noBody++; continue; }
    picked.push(p);
  }
  // 按发布时间升序：包内条目顺序稳定，两次导出的 diff 才有意义
  picked.sort((a, b) => String(a.published_at || a.created_at || '').localeCompare(String(b.published_at || b.created_at || '')));

  const usedMedia = new Set();
  const files = [];
  const usedNames = new Set();
  const uniqName = (want) => {
    let n = want;
    let k = 2;
    while (usedNames.has(n)) n = want.replace(/\.md$/, '') + '-' + (k++) + '.md';
    usedNames.add(n);
    return n;
  };
  const threadFor = new Map();   // post.id → 导出后的 slug（评论 JSON 靠它挂靠）

  for (const p of picked) {
    const isPage = p.type === 'page';
    const cat = catById.get(p.category_id);
    if (cat) p.category = cat;   // postUrl 的 {category} 变量要用
    const catNames = cat ? catPath(catById, p.category_id) : [];
    const dateStr = fmDate(p.published_at || p.created_at);
    const body = rewriteMedia(p.content_md, withMedia ? '' : origin);
    for (const u of body.used) usedMedia.add(u);
    let cover = '';
    if (p.cover_key) {
      cover = '/media/' + String(p.cover_key).replace(/^media\//, '').replace(/^\/+/, '');
      usedMedia.add(cover);
      if (!withMedia && origin) cover = origin + cover;
    }
    const fm = hexoFrontMatter({
      title: p.title,
      date: p.published_at || p.created_at,
      updated: p.updated_at,
      categories: catNames,
      tags: tagsByPost.get(p.id) || [],
      description: p.excerpt,
      cover,
      isPage,
    });
    const rel = isPage
      ? 'pages/' + uniqName(safeFileName(p.slug) + '.md')
      : '_posts/' + uniqName(isoDate(dateStr) + '-' + safeFileName(p.slug) + '.md');
    files.push({ name: rel, data: fm + '\n\n' + body.text.replace(/\s+$/, '') + '\n' });
    if (isPage) stats.pages++; else stats.posts++;
    // 评论 JSON 里的 url 用站点自己的规则生成（文章走 permalink、页面固定 /p/<slug>）
    const rel0 = isPage ? pageUrl(p) : postUrl(sm, p);
    threadFor.set(p.id, {
      slug: p.slug, post_id: p.id, title: p.title,
      url: origin ? origin + rel0 : rel0,
      comments: [],
    });
  }

  // 视频/音频同样挂在 media/ 下，一并算作「媒体」；没有勾选打包时只统计不下载。
  stats.mediaRefs = usedMedia.size;
  if (withMedia && usedMedia.size) {
    if (usedMedia.size > MEDIA_MAX_FILES) {
      throw new Error('图片等媒体共 ' + usedMedia.size + ' 个，超过单次打包上限 ' + MEDIA_MAX_FILES
        + ' 个。请先取消勾选「连同图片一起打包」——不勾选时正文里的图片会指向线上地址，一样能用。');
    }
    if (!opts.r2) throw new Error('当前环境读不到 R2，无法打包图片，请取消勾选后重试');
    let total = 0;
    for (const u of [...usedMedia].sort()) {
      const key = mediaKeyOf(u);
      let obj = null;
      try { obj = await opts.r2.get(key); } catch (e) { obj = null; }
      if (!obj) { stats.missingMedia.push(key); continue; }
      const buf = new Uint8Array(await obj.arrayBuffer());
      total += buf.length;
      if (total > MEDIA_MAX_BYTES) {
        throw new Error('图片等媒体合计已超过 ' + Math.round(MEDIA_MAX_BYTES / 1048576) + 'MB 的上限，'
          + '无法一次打包。请先取消勾选「连同图片一起打包」——不勾选时正文里的图片会指向线上地址，一样能用。');
      }
      files.push({ name: key, data: buf });
      stats.media++;
    }
    stats.mediaBytes = total;
  }

  // 评论：只导已过审的。未过审/回收站是「还没决定要不要」的内容，
  // 混进导出件等于把没定论的东西一起搬走了。
  const okIds = new Set(picked.map((p) => p.id));
  for (const c of src.comments) {
    if (c.status !== 'approved') { stats.skipped.pendingComments++; continue; }
    const th = threadFor.get(c.post_id);
    if (!th) continue;   // 文章本身没导出（草稿/加密），它的评论也不导出
    th.comments.push({
      id: c.id,
      parent: c.parent_id || 0,
      author: c.author,
      email: c.email || '',
      website: c.website || '',
      content: c.content,
      created_at: c.created_at,
      is_admin: c.is_admin ? 1 : 0,
    });
    stats.comments++;
  }
  const threads = [...threadFor.values()].filter((t) => t.comments.length);
  stats.commentsIn = threads.length;

  files.push({
    name: '_comments.json',
    data: JSON.stringify({
      generated_at: opts.nowText || '',
      site: String(sm.get('site_title') || ''),
      origin,
      note: '只含已过审的评论；未过审与回收站中的评论未导出。parent 为 0 表示顶级评论，其余指向同篇文章内某条评论的 id。',
      threads,
    }, null, 2) + '\n',
  });

  files.unshift({ name: 'README.md', data: readmeOf({ stats, origin, withMedia, nowText: opts.nowText || '' }) });
  return { files, stats };
}

function readmeOf({ stats, origin, withMedia, nowText }) {
  const L = [];
  L.push('# 静态站点导出（Hexo 风格）');
  L.push('');
  L.push('本站内容导出成的 Markdown 合集，可直接交给 Hexo / Hugo / Astro 这类静态生成器重新生成网站。');
  L.push('');
  if (nowText) L.push('- 导出时间：' + nowText);
  if (origin) L.push('- 来源站点：' + origin);
  L.push('');
  L.push('## 目录');
  L.push('');
  L.push('| 路径 | 内容 |');
  L.push('| --- | --- |');
  L.push('| `_posts/` | 文章 ' + stats.posts + ' 篇，文件名 `YYYY-MM-DD-别名.md`，front matter 已按 Hexo 惯例写好 |');
  L.push('| `pages/` | 独立页面 ' + stats.pages + ' 个（「关于」这类），front matter 带 `layout: page` |');
  L.push('| `_comments.json` | 已过审评论 ' + stats.comments + ' 条，按文章分组 |');
  if (withMedia) {
    L.push('| `media/` | 正文与封面用到的图片等媒体 ' + stats.media + ' 个，共 ' + fmtSize(stats.mediaBytes) + ' |');
  } else if (stats.mediaRefs) {
    L.push('| — | 正文与封面引用了 ' + stats.mediaRefs + ' 个媒体文件，这次**没有**一起打包（见下方「图片」） |');
  }
  L.push('');
  L.push('## 怎么用');
  L.push('');
  L.push('- **Hexo**：把 `_posts/` 里的文件拷进 `source/_posts/`；`pages/` 里的每个文件放到 `source/<别名>/index.md`。');
  L.push('- **Hugo**：把 `_posts/` 拷进 `content/posts/`；`pages/` 拷进 `content/`。');
  L.push('- **Astro / 11ty / VitePress**：都认得 YAML front matter，按各自的 content 目录规则放即可。');
  if (withMedia) {
    L.push('- **图片**：正文里保留的是站内路径 `/media/…`，所以请把 `media/` 整个目录放到站点根的 `media/` 下 —— '
      + 'Hexo 放 `source/media/`、Hugo 放 `static/media/`、Astro 放 `public/media/`。放对位置图就都出来了。');
  } else if (origin) {
    L.push('- **图片**：这次没有连图片一起打包，正文里的图片已改写成绝对地址（`' + origin + '/media/…`），'
      + '直接指向原站。想让包完全自包含，请回后台勾上「连同图片一起打包」再导一次。');
  }
  L.push('');
  L.push('## 没有导出的内容');
  L.push('');
  const s = stats.skipped;
  const miss = [];
  if (s.unpublished) miss.push('未发布的文章 ' + s.unpublished + ' 篇（草稿等）');
  if (s.locked) miss.push('加密文章 ' + s.locked + ' 篇（导出即失去密码保护）');
  if (s.noBody) miss.push('正文为空的文章 ' + s.noBody + ' 篇');
  if (s.pendingComments) miss.push('未过审 / 回收站评论 ' + s.pendingComments + ' 条');
  L.push(miss.length ? '- ' + miss.join('；') + '。' : '- （没有跳过任何内容）');
  if (stats.missingMedia.length) {
    L.push('- ⚠️ 以下媒体在存储里找不到（文章里引用了但对象不存在），已跳过：');
    for (const k of stats.missingMedia.slice(0, 50)) L.push('  - `' + k + '`');
  }
  L.push('');
  L.push('> 时间统一是站点所用时区的本地时间，直接由原站数据切出，未做时区换算。');
  L.push('');
  return L.join('\n');
}

const fmtSize = (n) => {
  const b = Number(n) || 0;
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
};

// ============================================================
// 附件配对与地址改写（Ver 0.7 ③）
//
// SQL 里只有附件的「台账」，没有文件本体。所以这条路是：
//   ① 从每篇文章的 content_md / content_html 里抓出所有附件地址；
//   ② 归一成「uploads 之后的相对路径」，去附件压缩包里按路径找文件；
//   ③ 记下「原地址 → 包内路径」，等文件传进 R2 后整串替换。
//
// 为什么不按域名匹配：WordPress 的 guid 里常留着站点搬家前的旧域名，
// 拿它去比必错；而相对路径在三家程序里都稳定（wp-content/uploads、
// usr/uploads、zb_users/upload）。所以**只比路径**，域名只在判断
// 「这是不是外站图片」时用一次。
//
// 纯函数、不碰 DOM、不碰网络，Node 里能直接跑（测试就是这么跑的）。
// ============================================================

import { isMediaPath, mediaKindOfPath, mediaMime } from './unpack.js';

// 三家程序的附件目录。命中哪个都行 —— 取它**后面**的部分当相对路径。
// 注意顺序无关，正则里已经按最长优先写好了。
const ROOT_RE = /\/(?:wp-content\/uploads|usr\/uploads|zb_users\/upload|uploads)\//i;

// WordPress 会为同一张原图生成一堆尺寸，正文里引用的往往是缩略图。
// 包里如果只有原图，就得把尺寸后缀去掉再找一次。
const VARIANT_RE = /-(?:\d+x\d+|scaled|rotated|e\d{6,}|\d{10,}|copy|min)$/i;

// 从正文里抓「像附件地址」的片段。三种写法各有各的坑：
//   · Markdown  `![alt](url "title")` —— url 里可能有括号，取到第一个空白/右括号为止
//   · HTML      src / href / poster / data-src / data-original（懒加载插件）
//   · srcset    `a-300.jpg 300w, a-768.jpg 768w` —— 逗号分隔，每段第一个词是地址
const MD_LINK_RE = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?/g;
const ATTR_RE = /\b(?:src|href|poster|data-src|data-original|data-lazy-src)\s*=\s*(["'])([\s\S]*?)\1/gi;
const SRCSET_RE = /\b(?:srcset|data-srcset)\s*=\s*(["'])([\s\S]*?)\1/gi;

function hostOf(u) {
  const m = /^(?:[a-z][a-z0-9+.-]*:)?\/\/([^/]+)/i.exec(String(u || ''));
  return m ? m[1].toLowerCase().replace(/:\d+$/, '') : '';
}

// 把「原始写法」拆成 { rel, host, hasRoot }：
//   rel     uploads 之后的相对路径（认不出根目录时退化成去掉开头的整条路径）
//   host    绝对地址的域名；相对地址为空串
//   hasRoot 路径里有没有三家的标准附件目录 —— 有就说明是附件，不是外链
export function parseRef(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  if (/^(data:|mailto:|javascript:|tel:|#)/i.test(s)) return null;
  // 去掉 query / hash 之后再判扩展名，否则 `a.jpg?w=600` 会被判成「不是图片」
  s = s.split('#')[0].split('?')[0];
  if (!isMediaPath(s)) return null;

  let host = '';
  let path = s;
  const abs = /^(?:[a-z][a-z0-9+.-]*:)?\/\/[^/]+(\/.*)?$/i.exec(s);
  if (abs) {
    host = hostOf(s);
    path = abs[1] || '/';
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(s)) {
    return null; // ftp: / blob: 之类，不归我们管
  }

  try { path = decodeURIComponent(path); } catch (e) { /* 百分号写坏了就按原样比 */ }
  path = path.replace(/\\/g, '/').replace(/\/{2,}/g, '/');

  const rm = ROOT_RE.exec(path);
  const rel = rm ? path.slice(rm.index + rm[0].length) : path.replace(/^\/+/, '');
  if (!rel) return null;
  return { rel, host, hasRoot: !!rm };
}

// 从一段正文里收集所有候选地址（原样返回，替换时要用这个原串）
export function collectTokens(text, isHtml) {
  const out = new Set();
  const s = String(text || '');
  if (!s) return out;

  const md = new RegExp(MD_LINK_RE.source, 'g');
  let m;
  while ((m = md.exec(s))) out.add(m[1]);

  const attr = new RegExp(ATTR_RE.source, 'gi');
  while ((m = attr.exec(s))) out.add(m[2]);

  if (isHtml) {
    const ss = new RegExp(SRCSET_RE.source, 'gi');
    while ((m = ss.exec(s))) {
      for (const part of String(m[2]).split(',')) {
        const u = part.trim().split(/\s+/)[0];
        if (u) out.add(u);
      }
    }
  }
  return out;
}

// 索引：包内文件 → 三种查法（整路径 / 路径后缀 / 文件名）
// 导出是为了让测试能直接验「四级匹配」而不必每次都造一篇文章。
export function buildIndex(files) {
  const byRel = new Map();
  const byBase = new Map();
  const byPath = new Map();
  for (const f of files || []) {
    if (!f || !f.path) continue;
    byPath.set(f.path, f);
    if (!isMediaPath(f.path)) continue;
    const p = String(f.path).replace(/^\/+/, '');
    if (p.indexOf('media/') === 0 && p.split('/').length === 2) continue; // 本站导出包里的 media/ 不是源附件
    byRel.set(p.toLowerCase(), p);
    const base = p.split('/').pop().toLowerCase();
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(p);
  }
  return { byRel, byBase, byPath, total: byRel.size };
}

// 包里的路径可能比相对路径多套几层（压的是 wp-content 或整站根目录），
// 所以先精确、再按后缀。两万条以内这么扫一遍是毫秒级的。
function findBySuffix(idx, relLower) {
  const needle = '/' + relLower;
  for (const [k, v] of idx.byRel) if (k.endsWith(needle)) return v;
  return '';
}

export function stripVariant(rel) {
  const m = /^(.*)(\.[a-z0-9]+)$/i.exec(String(rel || ''));
  if (!m) return '';
  const bare = m[1].replace(/@2x$/i, '').replace(VARIANT_RE, '');
  return bare === m[1] ? '' : bare + m[2];
}

// 四级匹配：整路径 → 路径后缀 → 去掉尺寸后缀再来一遍 → 全包唯一同名。
// 最后一档只在「唯一」时认，同名多份宁可放弃 —— 宁可少配一张，也不要张冠李戴。
export function matchPath(idx, rel) {
  const r = String(rel || '').toLowerCase();
  if (!r) return '';
  let hit = idx.byRel.get(r) || findBySuffix(idx, r);
  if (hit) return hit;
  const alt = stripVariant(r);
  if (alt) {
    hit = idx.byRel.get(alt) || findBySuffix(idx, alt);
    if (hit) return hit;
  }
  const base = r.split('/').pop();
  const list = idx.byBase.get(base) || [];
  return list.length === 1 ? list[0] : '';
}

// ------------------------------------------------------------
// 主入口
// plan:  planImport 的产物（posts 里已有 content_md / content_html）
// files: unpack 的产物（附件压缩包里的文件）
// opts:  { sourceBase }  源站地址，只用来判断「这是不是外站图片」
// ------------------------------------------------------------
export function planAttach(plan, files, opts = {}) {
  const posts = (plan && plan.posts) || [];
  const sourceHost = hostOf(opts.sourceBase || '');
  const idx = buildIndex(files);
  const mediaByPath = new Map();
  const report = {
    refs: 0,        // 正文里认出的附件地址（按篇去重后累计）
    matched: 0,     // 配上了包内文件
    unresolved: 0,  // 指向本地/源站、但包里没有
    external: 0,    // 外站图片，不动
    docRefs: 0,     // pdf / docx 之类，服务端不收，保持原地址
    images: 0,      // 配上的图片张数
    others: 0,      // 配上的音视频个数
    missing: [],
    paths: idx.total,
    bytes: 0,
  };

  const addMedia = (zipPath, ref) => {
    if (!zipPath || !idx.byRel.has(zipPath.toLowerCase())) return;
    let m = mediaByPath.get(zipPath);
    if (!m) {
      const f = idx.byPath.get(zipPath);
      m = {
        path: zipPath,
        name: zipPath.split('/').pop(),
        kind: mediaKindOfPath(zipPath),
        mime: mediaMime(zipPath),
        size: f && f.bytes ? f.bytes.length : (f ? f.size || 0 : 0),
        bytes: f ? f.bytes : null,
        refs: new Set(),
      };
      mediaByPath.set(zipPath, m);
      // 只有图片进「图片张数」，音视频单独算 —— 清单上「N 张图片」不能把 mp4 也数进去
      if (m.kind === 'image') report.images = (report.images || 0) + 1;
      else report.others = (report.others || 0) + 1;
      report.bytes += m.size;
    }
    if (ref) m.refs.add(ref);
  };

  for (const post of posts) {
    const map = {};
    const tokens = new Set();
    // 两个字段是同一篇文章的两种写法（Markdown 与 HTML），都要扫：
    // 前台渲染的是 content_html，只改 md 等于没改。
    for (const t of collectTokens(post.content_md, false)) tokens.add(t);
    for (const t of collectTokens(post.content_html, true)) tokens.add(t);

    for (const tk of tokens) {
      if (/^\/media\//.test(tk)) continue; // 已经是本站地址
      const info = parseRef(tk);
      if (!info) {
        // 不是媒体就跳过；文档类（pdf / docx / 压缩包）单独记一笔 ——
        // 服务端只收图片音视频，这类文件搬不了，要让用户知道不是漏了。
        if (/\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z)(?:[?#]|$)/i.test(tk)) report.docRefs++;
        continue;
      }
      report.refs++;
      // 绝对地址、域名对不上、路径里又没有三家标准目录 → 别动别人的图
      if (info.host && info.host !== sourceHost && !info.hasRoot) { report.external++; continue; }
      if (!idx.total) { report.unresolved++; continue; }

      const hit = matchPath(idx, info.rel);
      if (!hit) {
        report.unresolved++;
        if (report.missing.length < 20) report.missing.push(info.rel);
        continue;
      }
      map[tk] = hit;
      report.matched++;
      addMedia(hit, tk);
    }

    if (Object.keys(map).length) post._media_map = map;

    // WordPress 特色图：它不一定出现在正文里，所以单独当一次引用处理。
    if (post._cover_ref) {
      const info = parseRef(post._cover_ref) || { rel: String(post._cover_ref).replace(/^\/+/, '') };
      const hit = matchPath(idx, info.rel);
      if (hit) { post._cover_path = hit; addMedia(hit, post._cover_ref); }
      // 注意：这里**不删** _cover_ref —— 用户可能接着拖第二个包，
      // 重算时要能再配一次。清理放在 applyAttach 里。
    }
  }

  // 包里一个媒体文件都没有：多半是拖错了包（比如把文章包拖成了附件包）
  report.empty = idx.total === 0;
  return { media: [...mediaByPath.values()], report };
}

// ------------------------------------------------------------
// 文件传上去之后：把原地址整串换成本站地址。
// 两个字段一起换 —— content_html 才是前台渲染用的那一列。
// ------------------------------------------------------------
export function applyAttach(posts, urlByPath) {
  const pick = (p) => (urlByPath instanceof Map ? urlByPath.get(p) : urlByPath[p]) || '';
  let n = 0;
  for (const post of posts || []) {
    const map = post._media_map || {};
    for (const [token, path] of Object.entries(map)) {
      const url = pick(path);
      if (!url || !token || token === url) continue;
      let hit = false;
      for (const k of ['content_md', 'content_html']) {
        const s = post[k];
        if (s && s.includes(token)) { post[k] = s.split(token).join(url); hit = true; }
      }
      if (hit) n++;
    }
    if (post._cover_path) {
      const url = pick(post._cover_path);
      if (url) post.cover_key = url.replace(/^\/media\//, '');
      delete post._cover_path;
    }
    delete post._cover_ref;
    delete post._media_map;
  }
  return n;
}

// ============================================================
// 静态博客导入：把压缩包里的 Markdown 规划成本站的表与列（Ver 0.7 ②）
//
// 与 ① 共用同一套「全量重编号」策略与同一套写库接口，所以这里产出的 plan
// 形状和 importplan.js 完全一致：{ categories, tags, posts, post_tags, comments }。
//
// 要认的东西比 SQL 那步更杂，规则写在这里：
//  · 目录：Hexo（source/_posts）、Hugo（content/posts）、Jekyll（_posts）、
//    Astro（src/content/...）、以及任何「一堆 .md 平铺」的目录都能认。
//  · front matter：YAML（---）与 TOML（+++）都认，只认常用的十来个键。
//  · 文章还是独立页面：front matter 的 layout/type 优先，其次看目录名
//    （pages/ _pages/），最后看它是不是某个目录下的 index.md（Hexo 的独立页）。
//  · 图片：正文引用先还原成「包内哪个文件」，等浏览器把图片传上 R2 之后，
//    再把引用串换成 /media/<key>。所以这里的正文可能暂时还是相对路径 ——
//    这一步不能把没上线的图写成死链。
// ============================================================

import { slugBase, normTime, uniqueSlug } from './importplan.js';
import { htmlToMarkdown } from './html2md.js';

const PAGE_DIR_RE = /(^|\/)(pages?|_pages)\//i;
const POST_DIR_RE = /(^|\/)(_posts|_drafts|posts|blog|content\/posts|content\/blog)\//i;
const SKIP_FILE_RE = /(^|\/)(readme|license|changelog|contributing|package|tsconfig|\.gitignore)(\.[a-z]+)?$/i;
const SKIP_DIR_RE = /(^|\/)(\.github|\.vscode|\.idea|node_modules|themes?|public|static|assets\/js|assets\/css|scaffolds|source\/_data)\//i;

const MD_IMG_RE = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g;
const HTML_IMG_RE = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
const HEXO_ASSET_RE = /\{%\s*asset_img\s+([^\s%}]+)[^%]*%\}/g;

function pad2(n) { return String(n).padStart(2, '0'); }

// 只把「引号、行内数组、布尔」这几样解析出来 —— front matter 里 99% 就这些。
function unquote(v) {
  const s = String(v || '').trim();
  if (s.length >= 2 && ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'"))) {
    const body = s.slice(1, -1);
    return s[0] === '"' ? body.replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\') : body.replace(/''/g, "'");
  }
  return s;
}

function scalar(v) {
  const s = unquote(v);
  if (/^(true|yes|on)$/i.test(s)) return true;
  if (/^(false|no|off)$/i.test(s)) return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  return s;
}

function splitInlineArray(s) {
  const body = s.trim().replace(/^\[/, '').replace(/\]$/, '');
  const out = [];
  let cur = '';
  let q = '';
  for (const ch of body) {
    if (q) {
      cur += ch;
      if (ch === q) q = '';
      continue;
    }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === ',') { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => scalar(x)).filter((x) => x !== '');
}

function parseYamlLite(lines) {
  const out = {};
  let key = '';
  for (const raw of lines) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const item = /^\s*-\s*(.*)$/.exec(raw);
    if (item && key) {
      if (!Array.isArray(out[key])) out[key] = out[key] === '' || out[key] === undefined ? [] : [out[key]];
      const v = scalar(item[1]);
      if (Array.isArray(v)) out[key].push(...v); else out[key].push(v);
      continue;
    }
    const m = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(raw);
    if (!m) continue;
    key = m[1];
    const v = m[2].trim();
    if (!v) { out[key] = ''; continue; }
    out[key] = v.startsWith('[') ? splitInlineArray(v) : scalar(v);
  }
  return out;
}

function parseTomlLite(lines) {
  const out = {};
  for (const raw of lines) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const m = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(raw);
    if (!m) continue;
    const v = m[2].trim();
    out[m[1]] = v.startsWith('[') ? splitInlineArray(v) : scalar(v);
  }
  return out;
}

// 没有 front matter 也要能导：返回 has=false，body 原样。
export function parseFrontMatter(text) {
  const src = String(text == null ? '' : text).replace(/^\uFEFF/, '');
  const lines = src.split(/\r?\n/);
  const first = (lines[0] || '').trim();
  if (first !== '---' && first !== '+++') return { data: {}, body: src, has: false };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === first) { end = i; break; }
  }
  if (end < 0) return { data: {}, body: src, has: false };
  const header = lines.slice(1, end);
  const data = first === '+++' ? parseTomlLite(header) : parseYamlLite(header);
  const body = lines.slice(end + 1).join('\n').replace(/^\s*\n/, '');
  return { data, body, has: true };
}

function pick(data, ...keys) {
  for (const k of keys) {
    const v = data[k];
    if (v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length)) return v;
  }
  return '';
}

function asList(v) {
  if (v === '' || v === undefined || v === null) return [];
  if (Array.isArray(v)) return v.flatMap((x) => (Array.isArray(x) ? x : [x])).map((x) => String(x).trim()).filter(Boolean);
  return [String(v).trim()].filter(Boolean);
}

function normJoin(dir, rel) {
  const parts = (dir ? dir + '/' + rel : rel).split('/');
  const out = [];
  for (const p of parts) {
    if (!p || p === '.') continue;
    if (p === '..') out.pop(); else out.push(p);
  }
  return out.join('/');
}

function stripMdExt(p) {
  return String(p || '').replace(/\.(md|markdown|mdown|mkd)$/i, '');
}

function mdPlain(md, max = 150) {
  const txt = String(md || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~`>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return max > 0 ? txt.slice(0, max) : txt;
}

// 正文其实是 HTML 的情况（.md 里整段 <p>）：转成 Markdown，否则前台会把整段
// 当纯文本挤成一行。判据要保守 —— Markdown 正文里出现几个 <br> 不能算。
function looksHtml(body) {
  const s = String(body || '');
  if (!/^\s*<(p|div|h[1-6]|ul|ol|table|blockquote)\b/i.test(s)) return false;
  const tags = (s.match(/<(p|div|h[1-6]|ul|ol|li|table|blockquote)\b/gi) || []).length;
  const mdMarks = (s.match(/^#{1,6}\s|^\s*[-*+]\s|\*\*|```/gm) || []).length;
  return tags >= 3 && mdTagsRatio(tags, mdMarks);
}
function mdTagsRatio(tags, mdMarks) { return tags >= mdMarks * 2; }

function guessFormat(paths, sampled) {
  const has = (re) => paths.some((p) => re.test(p));
  if (has(/(^|\/)source\/_posts\//) || has(/(^|\/)_posts\/\d{4}-/)) return { key: 'hexo', name: 'Hexo' };
  if (has(/(^|\/)content\/posts\//) || sampled.some((d) => d.layout || d.type === 'post')) return { key: 'hugo', name: 'Hugo' };
  if (has(/(^|\/)_posts\//)) return { key: 'jekyll', name: 'Jekyll' };
  if (has(/(^|\/)src\/content\//)) return { key: 'astro', name: 'Astro' };
  return { key: 'generic', name: '通用 Markdown' };
}

// ------------------------------------------------------------
// 主入口
// files: [{ path, bytes }]（unpack 的产物）
// meta:  { maxIds, slugs }（与 ① 同一个接口拿）
// opts.bigImages: 包里**有、但被体积上限拦下**的图片路径。只有把这些路径传进来，
//   才能把它们跟「包里根本没有」区分开 —— 否则同一张图会先被清单标成
//   「超过 8MB 没带上」，又被算成「没在包里找到」，两条提示互相打脸。
// ------------------------------------------------------------
export function planMarkdown(files, meta = {}, opts = {}) {
  const now = opts.now || localNow();
  const maxIds = meta.maxIds || {};
  const slugSets = {
    posts: new Set((meta.slugs && meta.slugs.posts) || []),
    categories: new Set((meta.slugs && meta.slugs.categories) || []),
    tags: new Set((meta.slugs && meta.slugs.tags) || []),
  };
  const seq = {
    posts: Number(maxIds.posts || 0) + 1,
    categories: Number(maxIds.categories || 0) + 1,
    tags: Number(maxIds.tags || 0) + 1,
    comments: Number(maxIds.comments || 0) + 1,
  };

  const list = (files || []).map((f) => ({ path: String(f.path || ''), bytes: f.bytes })).filter((f) => f.path);
  const mdFiles = list.filter((f) => /\.(md|markdown|mdown|mkd)$/i.test(f.path)).sort((a, b) => a.path.localeCompare(b.path));
  const imgIndex = new Map();       // 包内路径 → 文件
  const byName = new Map();         // 文件名 → [路径]
  const bigIndex = new Set((opts.bigImages || []).map((p) => String(p || '')).filter(Boolean));
  const bigByName = new Map();      // 大图也要能按文件名兜底，否则「唯一同名」这条认不出来
  for (const p of bigIndex) {
    const b = p.split('/').pop().toLowerCase();
    if (!bigByName.has(b)) bigByName.set(b, []);
    bigByName.get(b).push(p);
  }
  const commentsFile = list.find((f) => /(^|\/)_comments\.json$/i.test(f.path));
  for (const f of list) {
    if (!/\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(f.path)) continue;
    imgIndex.set(f.path, f);
    const base = f.path.split('/').pop().toLowerCase();
    if (!byName.has(base)) byName.set(base, []);
    byName.get(base).push(f.path);
  }

  const out = { categories: [], tags: [], posts: [], post_tags: [], comments: [] };
  const report = {
    format: '',
    formatName: '',
    counts: { posts: 0, pages: 0, categories: 0, tags: 0, comments: 0, postTags: 0, images: 0, drafts: 0 },
    skipped: { files: 0, posts: 0, comments: 0, media: 0 },
    reasons: {},
    renamed: [],
    warnings: [],
    mediaBytes: 0,
    encrypted: 0,
    images: 0,
    sourceBase: '',
  };
  const warn = (s) => {
    if (report.warnings.length < 12 && !report.warnings.includes(s)) report.warnings.push(s);
  };
  const skip = (kind, why) => {
    report.skipped[kind] = (report.skipped[kind] || 0) + 1;
    report.reasons[why] = (report.reasons[why] || 0) + 1;
  };

  // 抽样看 front matter，用来判断这套文件更像哪个生成器
  const sampled = mdFiles.slice(0, 5).map((f) => parseFrontMatter(new TextDecoder().decode(f.bytes)).data);
  const fmt = guessFormat(mdFiles.map((f) => f.path), sampled);
  report.format = fmt.key;
  report.formatName = fmt.name;

  // ---------- 分类 / 标签（按名字去重，不按源 id —— 这里没有 id） ----------
  const catByName = new Map();  // '父/子' → 新 id
  const catIdBySlug = new Map();
  const addCat = (names) => {
    let parent = 0;
    let id = 0;
    for (let i = 0; i < names.length && i < 2; i++) {
      const key = names.slice(0, i + 1).join('/');
      if (catByName.has(key)) { id = catByName.get(key); parent = id; continue; }
      const name = names[i].slice(0, 60);
      let base = slugBase(name);
      if (!base) base = 'cat-' + seq.categories;
      const slug = uniqueSlug(base, slugSets.categories, 'cat-' + seq.categories);
      if (base && slug !== base) report.renamed.push({ kind: '分类', from: base, to: slug });
      id = seq.categories++;
      out.categories.push({ id, name, slug, description: '', created_at: now, parent_id: parent, in_nav: 0 });
      report.counts.categories++;
      catByName.set(key, id);
      catIdBySlug.set(slug, id);
      parent = id;
    }
    if (names.length > 2) warn('分类只支持两级，更深的层级被压平了');
    return id;
  };

  const tagByName = new Map();
  const addTag = (name) => {
    const nm = String(name || '').trim().slice(0, 60);
    if (!nm) return 0;
    if (tagByName.has(nm)) return tagByName.get(nm);
    let base = slugBase(nm);
    if (!base) base = 'tag-' + seq.tags;
    const slug = uniqueSlug(base, slugSets.tags, 'tag-' + seq.tags);
    const id = seq.tags++;
    out.tags.push({ id, name: nm, slug, created_at: now });
    tagByName.set(nm, id);
    report.counts.tags++;
    return id;
  };

  // ---------- 图片引用 → 包内文件 ----------
  const mediaByPath = new Map();   // 包内路径 → { path, name, mime, size, bytes, refs:Set }
  let unresolved = 0;              // 正文里指向本地、但在包里找不到的图片数
  let lastBig = false;             // 上一次解析的结果其实是「包里有、超过 8MB」
  const resolveRef = (ref, mdPath) => {
    lastBig = false;
    let r = String(ref || '').trim();
    if (!r) return '';
    if (/^(https?:)?\/\//i.test(r) || /^data:/i.test(r) || /^mailto:/i.test(r) || /^javascript:/i.test(r)) return '';
    r = r.split('#')[0].split('?')[0];
    try { r = decodeURIComponent(r); } catch (e) { /* 保留原样 */ }
    if (!isImageRef(r)) return '';
    r = r.replace(/^\.\//, '');
    const dir = mdPath.includes('/') ? mdPath.slice(0, mdPath.lastIndexOf('/')) : '';
    const cands = [];
    if (r.startsWith('/')) {
      const rest = r.replace(/^\/+/, '');
      cands.push(rest, 'media/' + rest, 'source/' + rest, 'static/' + rest, 'public/' + rest);
    } else {
      cands.push(normJoin(dir, r), r, 'source/' + r, 'static/' + r, 'public/' + r);
      // Hexo 的资源目录：md 与同名文件夹并排（`xxxx.md` ↔ `xxxx/`），
      // 正文里写 `images/a.png` 时真图在 `xxxx/images/a.png`。这条必须排在
      // 文件名兜底之前 —— 否则两篇各有一张 photo.png 时谁也对不上。
      const stem = mdPath.split('/').pop().replace(/\.(md|markdown|mdown|mkd)$/i, '');
      cands.unshift(normJoin(dir, stem + '/' + r));
    }
    for (const c of cands) {
      if (imgIndex.has(c)) return c;
      // 文件确实在包里，只是被体积上限拦下了：算「认得出来」，但不能取用
      if (bigIndex.has(c)) { lastBig = true; return ''; }
    }
    // 目录结构对不上时按文件名兜底：只有唯一同名文件才认，避免张冠李戴
    const base = r.split('/').pop().toLowerCase();
    const hits = byName.get(base) || [];
    if (hits.length === 1) return hits[0];
    const bigHits = bigByName.get(base) || [];
    if (!hits.length && bigHits.length === 1) { lastBig = true; return ''; }
    return '';
  };
  const isImageRef = (r) => /\.(png|jpe?g|gif|webp|avif|bmp)(\?|#|$)/i.test(r);

  const addMedia = (archivePath, ref) => {
    if (!archivePath || !imgIndex.has(archivePath)) return '';
    let m = mediaByPath.get(archivePath);
    if (!m) {
      const f = imgIndex.get(archivePath);
      m = {
        path: archivePath,
        name: archivePath.split('/').pop(),
        mime: mimeOf(archivePath),
        size: f.bytes ? f.bytes.length : 0,
        bytes: f.bytes,
        refs: new Set(),
      };
      mediaByPath.set(archivePath, m);
      report.counts.images++;
      report.mediaBytes += m.size;
    }
    if (ref) m.refs.add(ref);
    return archivePath;
  };

  // ---------- 逐篇 ----------
  let autoSeq = 0;
  for (const f of mdFiles) {
    if (SKIP_DIR_RE.test(f.path)) { skip('files', '生成器的主题/静态目录'); continue; }
    if (SKIP_FILE_RE.test(f.path)) { skip('files', 'README / LICENSE 等说明文件'); continue; }

    let text = '';
    try { text = new TextDecoder('utf-8').decode(f.bytes); } catch (e) { skip('files', '不是 UTF-8 文本'); continue; }
    const { data, body: rawBody, has } = parseFrontMatter(text);
    const fm = has ? data : {};
    const body0 = rawBody;

    const isIndex = /(^|\/)index\.md$/i.test(f.path) || /(^|\/)_index\.md$/i.test(f.path);
    const layout = String(pick(fm, 'layout', 'type') || '').toLowerCase();
    const underPages = PAGE_DIR_RE.test(f.path);
    const underPosts = POST_DIR_RE.test(f.path);
    let isPage = false;
    if (layout === 'page' || layout === 'standalone') isPage = true;
    else if (layout === 'post' || layout === 'article') isPage = false;
    else if (underPages) isPage = true;
    else if (underPosts) isPage = false;
    else if (isIndex) isPage = true;
    // Hugo 的顶层 content/about.md 是独立页面；但 content/posts/… 上面已经判过了
    else if (/^content\/[^/]+\.md$/i.test(f.path)) isPage = true;
    // Hugo 的 `_index.md` 是「栏目列表页」，本身不是内容，跳过
    if (/(^|\/)_index\.md$/i.test(f.path)) { skip('posts', '栏目索引页 _index.md'); continue; }

    let body = body0;

    // 标题：front matter → 正文第一个 # 标题 → 文件名
    let title = String(pick(fm, 'title', 'name') || '').trim();
    const firstH1 = /^\s*#\s+(.+?)\s*$/m.exec(body.slice(0, 2000));
    if (!title && firstH1) title = firstH1[1].trim();
    if (!title) {
      const base = stripMdExt(f.path.split('/').pop());
      const dirName = f.path.split('/').slice(-2, -1)[0] || '';
      title = (/^(index|_index)$/i.test(base) && dirName ? dirName : base).replace(/^\d{4}-\d{2}-\d{2}[-_ ]/, '') || '未命名文章';
    }
    // 正文开头重复一遍标题（`# 标题`）就去掉，否则前台会出现「标题 + 同名大标题」
    if (firstH1 && title && firstH1[1].trim() === title && firstH1.index < 40) {
      body = body.replace(firstH1[0], '').replace(/^\s*\n/, '');
    } else if (firstH1 && !has) {
      body = body.replace(firstH1[0], '').replace(/^\s*\n/, '');
      title = title || firstH1[1].trim();
    }

    // 日期：front matter → 文件名前缀 → 导入时刻
    const dateRaw = pick(fm, 'date', 'created', 'published', 'pubDate', 'publishDate');
    let created = normTime(dateRaw, '');
    if (!created) {
      const m = /^(\d{4})-(\d{2})-(\d{2})[-_ ]/.exec(f.path.split('/').pop());
      if (m) created = `${m[1]}-${m[2]}-${m[3]} 00:00:00`;
    }
    if (!created) created = now;
    const updated = normTime(pick(fm, 'updated', 'modified', 'lastmod', 'last_modified'), created);

    const draftFlag = pick(fm, 'draft', 'draftFlag');
    const pubFlag = pick(fm, 'published');
    const isDraft = draftFlag === true || String(draftFlag).toLowerCase() === 'true'
      || pubFlag === false || String(pubFlag).toLowerCase() === 'false'
      || /(^|\/)_drafts\//i.test(f.path);

    // slug：front matter → 文件名（去日期前缀）→ index.md 用所在目录名
    let slugRaw = String(pick(fm, 'slug', 'abbrlink', 'urlname', 'permalink') || '');
    if (slugRaw && slugRaw.includes('/')) slugRaw = slugRaw.replace(/\/+$/, '').split('/').pop();
    const fileBase = stripMdExt(f.path.split('/').pop());
    const dirParts = f.path.split('/').slice(0, -1);
    if (!slugRaw) {
      // Hexo 的独立页是 source/about/index.md → 地址应该是 /p/about 而不是 /p/index
      if (/^(index|_index)$/i.test(fileBase) && dirParts.length) slugRaw = dirParts[dirParts.length - 1];
      else slugRaw = fileBase.replace(/^\d{4}-\d{2}-\d{2}[-_ ]/, '');
    }
    let base = slugBase(slugRaw);
    if (!base) base = (isPage ? 'page-' : 'post-') + (++autoSeq);
    const slug = uniqueSlug(base, slugSets.posts, 'post-' + (++autoSeq));
    if (base && slug !== base) report.renamed.push({ kind: isPage ? '页面' : '文章', from: base, to: slug });

    // 正文：HTML 形态转 Markdown；<!-- more --> 之前的部分当摘要
    if (looksHtml(body)) {
      try { body = htmlToMarkdown(body); } catch (e) { /* 转不动就原样 */ }
    }
    let excerpt = '';
    const moreIdx = body.indexOf('<!-- more -->');
    if (moreIdx >= 0) {
      excerpt = mdPlain(body.slice(0, moreIdx));
      body = body.slice(0, moreIdx) + body.slice(moreIdx + '<!-- more -->'.length);
    }
    const fmExcerpt = pick(fm, 'excerpt', 'description', 'summary', 'subtitle');
    if (fmExcerpt) excerpt = String(fmExcerpt).replace(/<[^>]*>/g, '').trim().slice(0, 200);
    if (!excerpt) excerpt = mdPlain(body);

    // 图片：收集正文里所有引用，能对上包内文件的记下来。
    // 记的是「这一篇里哪个引用串 → 包内哪个文件」——同一个 `a.png` 在两篇文章里
    // 可能指向不同的文件，所以必须按篇记，不能在全局替换。
    const mediaMap = {};
    const collect = (re, fix) => {
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(body))) {
        const ref = fix ? fix(m) : m[1];
        if (!isImageRef(ref)) continue;
        const p = resolveRef(ref, f.path);
        if (p) { addMedia(p, ref); mediaMap[ref] = p; }
        // 超体积的图已在清单里点名，不算「没找到」—— 否则两条提示自相矛盾
        else if (lastBig) { /* 忽略 */ }
        else if (!/^(https?:)?\/\//i.test(ref) && !/^data:/i.test(ref)) unresolved++;
      }
    };
    collect(MD_IMG_RE);
    collect(HTML_IMG_RE);
    collect(HEXO_ASSET_RE, (m) => m[1]);

    // 封面：front matter 指到包内图片就一起上传，指到外链就留空
    const coverRaw = String(pick(fm, 'cover', 'image', 'thumbnail', 'banner', 'featured_image', 'feature') || '');
    let coverPath = '';
    if (coverRaw) {
      coverPath = resolveRef(coverRaw, f.path);
      if (coverPath) addMedia(coverPath, coverRaw);
      else if (lastBig) { /* 同上：清单里已经点过名 */ }
      else if (!/^(https?:)?\/\//i.test(coverRaw)) warn('封面图没在压缩包里找到：' + coverRaw);
    }

    // 分类：Hexo 的 categories 是「层级路径」，Hugo 的是「多个分类」——
    // 按包的结构区分：_posts 里的扁平数组当路径，其余取第一个。
    let catNames = asList(pick(fm, 'categories', 'category'));
    const hexoStyle = /(^|\/)_posts\//i.test(f.path);
    if (!hexoStyle && catNames.length > 1) {
      warn('一篇文章只挂一个分类，多出来的分类没有导入');
      catNames = catNames.slice(0, 1);
    }
    const categoryId = catNames.length ? addCat(catNames) : null;

    const tagNames = asList(pick(fm, 'tags', 'tag', 'keywords'));
    const tagIds = [];
    for (const t of tagNames) {
      const id = addTag(t);
      if (id && !tagIds.includes(id)) tagIds.push(id);
    }

    const id = seq.posts++;
    out.posts.push({
      id,
      title: String(title).slice(0, 200),
      slug,
      excerpt: String(excerpt || '').slice(0, 300),
      content_md: body,
      content_html: '',
      cover_key: null,
      status: isDraft ? 'draft' : 'published',
      category_id: categoryId,
      view_count: 0,
      created_at: created,
      updated_at: updated || created,
      published_at: isDraft ? null : created,
      type: isPage ? 'page' : 'post',
      in_nav: 0,
      password: '',
      pin: 0,
      // 下面两个不是表字段（写库时会被白名单丢掉），给前端上传图片用
      _media_map: mediaMap,
      _cover_ref: coverRaw,
      _cover_path: coverPath,
    });
    if (isPage) report.counts.pages++; else report.counts.posts++;
    if (isDraft) report.counts.drafts++;
    for (const tid of tagIds) out.post_tags.push({ post_id: id, tag_id: tid });
  }

  report.counts.postTags = out.post_tags.length;

  // ---------- 评论（只认本博客自己导出的 _comments.json） ----------
  if (commentsFile) {
    let data = null;
    try { data = JSON.parse(new TextDecoder().decode(commentsFile.bytes)); } catch (e) { warn('_comments.json 不是合法 JSON，评论没有导入'); }
    const bySlug = new Map(out.posts.map((p) => [p.slug, p]));
    const threads = (data && Array.isArray(data.threads)) ? data.threads : [];
    if (data && !threads.length) warn('_comments.json 里没有评论线程');
    for (const th of threads) {
      const post = bySlug.get(String(th.slug || ''));
      if (!post) { skip('comments', '对应文章没有导入'); continue; }
      const idMap = new Map();
      for (const c of (th.comments || [])) {
        const oldId = Number(c.id || 0);
        const id = seq.comments++;
        if (oldId) idMap.set(oldId, id);
        const parentOld = Number(c.parent || 0);
        out.comments.push({
          id,
          post_id: post.id,
          parent_id: parentOld ? (idMap.get(parentOld) || null) : null,
          author: String(c.author || '匿名').slice(0, 40),
          email: String(c.email || ''),
          website: String(c.website || ''),
          content: String(c.content || '').slice(0, 4000),
          status: 'approved',
          is_admin: c.is_admin ? 1 : 0,
          ip: '',
          created_at: normTime(c.created_at, post.created_at),
        });
        report.counts.comments++;
      }
    }
  }

  const media = [...mediaByPath.values()].map((m) => ({
    path: m.path,
    name: m.name,
    mime: m.mime,
    size: m.size,
    bytes: m.bytes,
    refs: [...m.refs],
  }));
  media.sort((a, b) => a.path.localeCompare(b.path));

  if (!out.posts.length) {
    warn('压缩包里没有找到可导入的 Markdown 文章');
  }
  // 这条不能挂在 media.length 里 —— 一篇文章的图**全都**找不到时，media 是空的，
  // 恰恰最该提示，却会一声不响。
  if (unresolved) warn(`有 ${unresolved} 处图片引用没在包里找到，导入后这些图会保持原样`);

  return { plan: out, media, report };
}

// 图片上传完之后，把正文与封面里的引用换成 R2 的地址。
// urlByPath: { 包内路径: '/media/<key>' }（Map 或普通对象都行）
// 单独抽出来是为了能测：上传是网络行为，替换是纯字符串处理，两者混在一起就测不清。
export function applyMedia(posts, urlByPath) {
  const pickUrl = (p) => (urlByPath instanceof Map ? urlByPath.get(p) : urlByPath[p]) || '';
  let n = 0;
  for (const post of posts || []) {
    const map = post._media_map || {};
    for (const [ref, path] of Object.entries(map)) {
      const url = pickUrl(path);
      if (!url) continue;
      // 两个字段都换：静态博客这条路 content_html 一般为空，但 SQL 导入的
      // HTML 正文是非空的，只改 Markdown 等于没改（前台渲染的是 content_html）。
      let hit = false;
      for (const k of ['content_md', 'content_html']) {
        const s = post[k];
        if (s && s.includes(ref)) { post[k] = s.split(ref).join(url); hit = true; }
      }
      if (hit) n++;
    }
    // 配对表只给上传后替换用，落库前删掉，别让它跟着请求体跑一趟
    delete post._media_map;
    if (post._cover_path) {
      const url = pickUrl(post._cover_path);
      if (url) post.cover_key = url.replace(/^\/media\//, '');
      delete post._cover_path;
    }
  }
  return n;
}

function mimeOf(p) {
  const m = /\.([a-z0-9]+)$/i.exec(String(p || ''));
  const k = m ? m[1].toLowerCase() : '';
  return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp' })[k] || 'application/octet-stream';
}

function localNow() {
  const d = new Date(Date.now() + 8 * 3600e3);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

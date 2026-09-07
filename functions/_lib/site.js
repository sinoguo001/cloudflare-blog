// ============================================================
// 博客前台页面渲染（Worker 端 SSR）
// 路由入口在 functions/[[path]].js，本文件只负责拼 HTML。
// ============================================================
import * as db from './db.js';
import { esc, fmtDate, rfc822, stripHtml, isHexColor } from './util.js';

const ACCENT = '#2563eb';
export function accentOf(s) { return isHexColor(s.get('accent')) ? s.get('accent') : ACCENT; }

// 当前激活主题的样式表外链；内置 default 主题无独立文件，返回空
export function themeLink(s, base = '') {
  const id = (s.get('active_theme') || '').trim();
  if (!id || id === 'default') return '';
  return '<link rel="stylesheet" href="' + base + '/theme-assets/' + encodeURIComponent(id) + '/style.css">';
}

// ---------- 主题变量：默认观感即内置 default 主题 ----------
// 已安装主题的 style.css 在本样式之后加载：可覆盖变量，或直接覆盖任意类选择器。
export const THEME_VARS = `
:root{
--bg:#f6f7f9;--card:#fff;--text:#1f2937;--text-soft:#4b5563;--muted:#6b7280;--line:#e5e7eb;
--accent:#2563eb;--accent-soft:#eef2ff;--on-accent:#fff;--tint:#f3f6ff;
--quote-bg:#f3f6ff;--quote-text:#374151;--code-bg:#0f172a;--code-text:#e2e8f0;--inline-code-bg:#eef1f5;
--admin:#7c3aed;--admin-soft:#ede9fe;--admin-text:#6d28d9;--ok:#15803d;--bad:#b91c1c;
--font-body:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
--font-code:Consolas,Menlo,Monaco,"Courier New",monospace}
`;

// ---------- 前台骨架样式（颜色一律引用主题变量） ----------
export const FRONT_CSS = `
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.75 var(--font-body)}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
img{max-width:100%}
.wrap{max-width:880px;margin:0 auto;padding:0 20px}
/* 顶栏 */
.hd{background:var(--card);border-bottom:1px solid var(--line)}
.hd-in{display:flex;align-items:center;gap:18px;flex-wrap:wrap;padding:14px 0}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:20px;color:var(--text);margin-right:auto}
.brand-mark{width:34px;height:34px;border-radius:9px;background:var(--accent);color:var(--on-accent);display:inline-flex;align-items:center;justify-content:center;font-weight:800}
.brand small{display:block;font-weight:400;font-size:12px;color:var(--muted);line-height:1.2}
.nav{display:flex;gap:4px;flex-wrap:wrap;align-items:center}
.nav a{padding:6px 12px;border-radius:8px;color:var(--text);font-size:15px}
.nav a:hover{background:var(--accent-soft);text-decoration:none}
.nav a.on{background:var(--accent);color:var(--on-accent)}
.hd-search input{padding:7px 12px;border:1px solid var(--line);border-radius:9px;font-size:14px;width:170px;outline:none}
.hd-search input:focus{border-color:var(--accent)}
/* 主区 */
.main{padding:26px 0 60px}
.hero{padding:26px 0 8px}
.hero h1{margin:0 0 6px;font-size:34px;letter-spacing:.5px}
.hero p{margin:0;color:var(--muted)}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin:18px 0 6px}
.chip{background:var(--card);border:1px solid var(--line);border-radius:999px;padding:4px 14px;font-size:13px;color:var(--text)}
.chip b{color:var(--muted);font-weight:400}
.chip:hover{border-color:var(--accent);text-decoration:none}
/* 文章卡片 */
.plist{display:grid;gap:18px;margin-top:18px}
.pc{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px 22px;display:grid;grid-template-columns:1fr auto;gap:18px;align-items:center}
.pc.no-cover{grid-template-columns:1fr}
.pc-meta{font-size:13px;color:var(--muted);display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:6px}
.pc-meta a{color:var(--muted)}
.pc-meta a:hover{color:var(--accent)}
.dot{opacity:.5}
.pc-title{margin:0 0 8px;font-size:21px;line-height:1.45}
.pc-title a{color:var(--text)}
.pc-title a:hover{color:var(--accent)}
.pc-excerpt{margin:0 0 10px;color:var(--text-soft);font-size:15px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.pc-tags{display:flex;gap:6px;flex-wrap:wrap}
.tag-chip{font-size:12px;background:var(--accent-soft);color:var(--accent);padding:2px 10px;border-radius:999px}
.tag-chip:hover{text-decoration:none;background:var(--accent);color:var(--on-accent)}
.pc-cover a{display:block}
.pc-cover img{width:200px;height:130px;object-fit:cover;border-radius:10px;border:1px solid var(--line)}
/* 分页 */
.pager{display:flex;justify-content:center;gap:6px;margin-top:30px;flex-wrap:wrap}
.pager a,.pager span{padding:6px 13px;border-radius:9px;background:var(--card);border:1px solid var(--line);font-size:14px;color:var(--text)}
.pager a:hover{border-color:var(--accent);text-decoration:none}
.pager .cur{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
.pager .dim{opacity:.45;pointer-events:none}
/* 文章页 */
.crumb{margin:2px 0 14px;font-size:14px;color:var(--muted)}
.article{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:34px 40px}
.article h1{margin:0 0 10px;font-size:30px;line-height:1.4}
.art-meta{font-size:13.5px;color:var(--muted);display:flex;gap:12px;flex-wrap:wrap;align-items:center;padding-bottom:16px;border-bottom:1px solid var(--line);margin-bottom:20px}
.art-cover{margin-bottom:22px}
.art-cover img{border-radius:12px;border:1px solid var(--line)}
/* 正文排版 */
.art-body{font-size:16.5px}
.art-body h2{font-size:23px;margin:1.6em 0 .6em;padding-left:11px;border-left:4px solid var(--accent)}
.art-body h3{font-size:19px;margin:1.5em 0 .5em}
.art-body h4{font-size:17px;margin:1.4em 0 .4em}
.art-body p{margin:0 0 1.05em}
.art-body ul,.art-body ol{margin:0 0 1.1em;padding-left:1.6em}
.art-body li{margin:.25em 0}
.art-body li.task{list-style:none;margin-left:-1.2em}
.art-body li.task input{margin-right:8px;vertical-align:-2px}
.art-body blockquote{margin:1.2em 0;padding:10px 18px;border-left:4px solid var(--accent);background:var(--quote-bg);border-radius:0 10px 10px 0;color:var(--quote-text)}
.art-body blockquote p{margin:.4em 0}
.art-body a{text-decoration:underline;text-underline-offset:3px}
.art-body img{border-radius:10px;margin:6px 0;border:1px solid var(--line)}
.art-body hr{border:none;border-top:1px dashed var(--line);margin:2em 0}
.art-body pre{background:var(--code-bg);color:var(--code-text);padding:16px 18px;border-radius:12px;overflow:auto;font-size:14px;line-height:1.65}
.art-body code{font-family:var(--font-code);background:var(--inline-code-bg);border-radius:5px;padding:1.5px 6px;font-size:.9em}
.art-body pre code{background:none;color:inherit;padding:0;font-size:14px}
.art-body table{border-collapse:collapse;margin:1.2em 0;width:100%;font-size:15px}
.art-body th,.art-body td{border:1px solid var(--line);padding:8px 12px}
.art-body th{background:var(--tint)}
/* 上/下一篇 */
.pn{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:22px}
.pn a{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 18px;font-size:14px}
.pn .next{text-align:right}
.pn small{display:block;color:var(--muted);font-size:12px;margin-bottom:3px}
/* 评论 */
.comments{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:28px 34px;margin-top:22px}
.comments h2{margin:0 0 18px;font-size:20px}
.cmt{border-top:1px dashed var(--line);padding:16px 0}
.cmt-top{display:flex;align-items:center;gap:10px;margin-bottom:6px}
.avatar{width:34px;height:34px;border-radius:50%;background:var(--accent);color:var(--on-accent);display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:15px;flex:none}
.avatar.admin{background:var(--admin)}
.cmt-who b{font-size:14.5px}
.tag-mini{font-size:11px;background:var(--admin-soft);color:var(--admin-text);padding:1px 8px;border-radius:999px}
.cmt-time{font-size:12px;color:var(--muted)}
.cmt-body{color:var(--quote-text);font-size:15px;word-break:break-word}
.cmt-body p{margin:0 0 .4em}
.cmt-child{margin-left:52px}
.cform{margin-top:18px;padding-top:16px;border-top:1px solid var(--line)}
.cform .row{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:12px}
.cform input{flex:1;min-width:180px;padding:9px 12px;border:1px solid var(--line);border-radius:9px;font-size:14px;outline:none}
.cform textarea{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:9px;font-size:14px;min-height:110px;resize:vertical;outline:none;font-family:inherit}
.cform input:focus,.cform textarea:focus{border-color:var(--accent)}
.btn{display:inline-block;border:none;background:var(--accent);color:var(--on-accent);padding:9px 22px;border-radius:9px;font-size:14.5px;cursor:pointer}
.btn:hover{opacity:.9;text-decoration:none}
.hp-field{position:absolute!important;left:-9999px!important;width:1px;height:1px;overflow:hidden}
.cmsg{font-size:14px;margin:10px 0 0}
.cmsg.ok{color:var(--ok)}.cmsg.bad{color:var(--bad)}
/* 归档/标签页等 */
.page-head h1{font-size:27px;margin:0 0 4px}
.page-head .desc{color:var(--muted);font-size:14.5px;margin:0 0 16px}
.arc-y{margin-bottom:22px}
.arc-y>h2{font-size:20px;border-bottom:2px solid var(--line);padding-bottom:8px;margin:0 0 12px}
.arc-m{margin:6px 0 4px;font-weight:600;color:var(--text-soft)}
.arc-m ul{margin:4px 0 10px;padding-left:22px}
.arc-m li{margin:3px 0}
.arc-m a{color:var(--text)}
.arc-m a:hover{color:var(--accent)}
.arc-m time{color:var(--muted);font-size:13px;margin-right:10px}
.tags-cloud{display:flex;flex-wrap:wrap;gap:10px;margin-top:6px}
.tag-pill{background:var(--card);border:1px solid var(--line);border-radius:999px;padding:6px 16px;font-size:14px;color:var(--text)}
.tag-pill b{color:var(--muted);font-weight:400;font-size:12.5px}
.tag-pill:hover{border-color:var(--accent);text-decoration:none}
.cat-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:14px;margin-top:14px}
.cat-card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px 20px}
.cat-card h3{margin:0 0 6px;font-size:18px}
.cat-card h3 a{color:var(--text)}
.cat-card p{margin:0;color:var(--muted);font-size:13.5px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.cat-card .cnt{color:var(--accent);font-size:12.5px;display:block;margin-top:8px}
.empty{background:var(--card);border:1px dashed var(--line);border-radius:12px;padding:34px;text-align:center;color:var(--muted);margin-top:18px}
/* 页脚 */
.ft{border-top:1px solid var(--line);background:var(--card);color:var(--muted);font-size:13.5px;padding:20px 0;text-align:center}
.ft a{color:var(--muted)}
@media (max-width:640px){
 .pc{grid-template-columns:1fr}.pc-cover img{width:100%;height:auto;max-height:180px}
 .article{padding:22px 18px}.comments{padding:20px 18px}.cmt-child{margin-left:20px}
 .hd-search input{width:100%}
}
`;

// ---------- 页面骨架 ----------
export function layout(s, o) {
  const title = s.get('site_title');
  const accent = accentOf(s);
  const desc = o.desc || s.get('seo_desc') || s.get('site_subtitle');
  const year = new Date(Date.now() + 8 * 3600e3).getUTCFullYear();
  const footer = (s.get('footer_text') || '').split('\n').map(esc).join('<br>');
  const nav = (href, label, key) =>
    `<a href="${href}"${o.active === key ? ' class="on"' : ''}>${esc(label)}</a>`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${o.title ? esc(o.title) + ' · ' + esc(title) : esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="alternate" type="application/rss+xml" title="${esc(title)}" href="/rss.xml">
<style>:root{--accent:${accent}}${THEME_VARS}${FRONT_CSS}</style>
${themeLink(s)}
${o.bodySlug ? '<script src="/js/site.js" defer></script>' : ''}
</head>
<body data-slug="${o.bodySlug || ''}">
<header class="hd"><div class="wrap hd-in">
  <a class="brand" href="/"><span class="brand-mark">${esc((title || '博').trim().slice(0, 1))}</span>
    <span>${esc(title)}<small>${esc(s.get('site_subtitle'))}</small></span></a>
  <nav class="nav">
    ${nav('/', '首页', 'home')}
    ${nav('/categories', '分类', 'cat')}
    ${nav('/tags', '标签', 'tags')}
    ${nav('/archive', '归档', 'arc')}
    ${nav('/rss.xml', 'RSS', 'rss')}
  </nav>
  <form class="hd-search" action="/search" method="get"><input name="q" placeholder="搜索文章…" value="${o.q ? esc(o.q) : ''}"></form>
</div></header>
<main class="main"><div class="wrap">${o.content}</div></main>
<footer class="ft"><div class="wrap">
  ${footer ? footer + '<br>' : ''}© ${year} ${esc(title)} · 由 Cloudflare Pages 驱动 · <a href="/admin">后台管理</a>
</div></footer>
</body>
</html>`;
}

// ---------- 通用片段 ----------
function catChips(list) {
  if (!list.length) return '';
  return `<div class="chips">${list.map((c) => `<a class="chip" href="/category/${esc(c.slug)}">${esc(c.name)}<b> ${c.count || 0}</b></a>`).join('')}</div>`;
}
function postCard(p) {
  const cover = p.cover_key
    ? `<div class="pc-cover"><a href="/post/${esc(p.slug)}"><img src="/media/${esc(p.cover_key)}" alt="" loading="lazy"></a></div>` : '';
  const cat = p.category ? `<a href="/category/${esc(p.category.slug)}">${esc(p.category.name)}</a>` : '';
  const excerpt = p.excerpt || stripHtml(p.content_html).slice(0, 180);
  const tags = (p.tags || []).map((t) => `<a class="tag-chip" href="/tag/${esc(t.slug)}">${esc(t.name)}</a>`).join('');
  return `<article class="pc${cover ? '' : ' no-cover'}"><div>
    <div class="pc-meta">
      <time>${fmtDate(p.published_at || p.created_at)}</time>
      ${cat ? `<span class="dot">·</span>${cat}` : ''}
      <span class="dot">·</span><span>阅读 ${p.view_count || 0}</span>
      <span class="dot">·</span><span>${p.comment_count || 0} 评论</span>
    </div>
    <h2 class="pc-title"><a href="/post/${esc(p.slug)}">${esc(p.title)}</a></h2>
    ${excerpt ? `<p class="pc-excerpt">${esc(excerpt)}</p>` : ''}
    ${tags ? `<div class="pc-tags">${tags}</div>` : ''}
  </div>${cover}</article>`;
}
function pagination(page, pages, base, pageSize) {
  if (pages <= 1) return '';
  const link = (n) => (n === 1 ? base : `${base}${pageSize ? 'page/' : ''}${n}`).replace(/(\/)\1/g, '$1');
  const wrap = base === '/' ? 'page/' : '';
  const item = (n) => (n === page ? `<span class="cur">${n}</span>` : `<a href="${base}${wrap}${n}">${n}</a>`);
  let nums = '';
  const from = Math.max(1, page - 2), to = Math.min(pages, page + 2);
  for (let n = from; n <= to; n++) nums += item(n);
  const fmt = (base === '/' ? `/page/${page - 1}` : `${base}page/${page - 1}`).replace('/page/1', base === '/' ? '/' : base);
  const prev = page > 1 ? `<a href="${fmt}">‹ 上一页</a>` : `<span class="dim">‹ 上一页</span>`;
  const next = page < pages ? `<a href="${base}${wrap}${page + 1}">下一页 ›</a>` : `<span class="dim">下一页 ›</span>`;
  return `<nav class="pager">${prev}${nums}${next}</nav>`;
}

// ---------- 各页面 ----------
export function renderHome(s, data, page) {
  const items = data.items.map(postCard).join('');
  const content = `
    <section class="hero"><h1>${esc(s.get('site_subtitle'))}</h1></section>
    ${catChips(data.categories)}
    ${items ? `<div class="plist">${items}</div>` + pagination(page, data.pages, '/', 1)
      : `<div class="empty">还没有发布文章，快去后台写第一篇吧 → <a href="/admin">管理后台</a></div>`}
    ${pagination(page, data.pages, '/', 1) ? '' : ''}`;
  return layout(s, { content, active: 'home', bodySlug: '' });
}

export function renderListPage(s, o) {
  // o: {head, desc, itemsHtml, page, pages, base}
  return layout(s, {
    active: o.active, q: o.q, title: o.title,
    content: `<section class="page-head"><h1>${o.head}</h1>${o.desc ? `<p class="desc">${o.desc}</p>` : ''}${o.extra || ''}</section>
    ${o.itemsHtml ? `<div class="plist">${o.itemsHtml}</div>` : `<div class="empty">${o.empty || '暂无内容'}</div>`}
    ${pagination(o.page, o.pages, o.base, o.pageSize)}`,
  });
}

export function renderArticle(s, post, extra) {
  const cover = post.cover_key
    ? `<div class="art-cover"><img src="/media/${esc(post.cover_key)}" alt="${esc(post.title)}"></div>` : '';
  const tags = (post.tags || []).map((t) => `<a class="tag-chip" href="/tag/${esc(t.slug)}">${esc(t.name)}</a>`).join('');
  const meta = [
    `<span>${esc(s.get('author_name'))}</span>`,
    `<time>${fmtDate(post.published_at, true)}</time>`,
    post.category ? `<a href="/category/${esc(post.category.slug)}">${esc(post.category.name)}</a>` : '',
    `<span>${post.view_count || 0} 次阅读</span>`,
  ].filter(Boolean).join('<span class="dot">·</span>');
  const pn = extra.siblings;
  const pnHtml = `<nav class="pn">
    ${pn.prev ? `<a href="/post/${esc(pn.prev.slug)}"><small>← 上一篇</small>${esc(pn.prev.title)}</a>` : '<span></span>'}
    ${pn.next ? `<a class="next" href="/post/${esc(pn.next.slug)}"><small>下一篇 →</small>${esc(pn.next.title)}</a>` : '<span></span>'}
  </nav>`;
  const content = `
    <p class="crumb"><a href="/">首页</a> / ${post.category ? `<a href="/category/${esc(post.category.slug)}">${esc(post.category.name)}</a> / ` : ''}正文</p>
    <article class="article">
      <h1>${esc(post.title)}</h1>
      <div class="art-meta">${meta}</div>
      ${cover}
      <div class="art-body">${post.content_html}</div>
      ${tags ? `<div class="pc-tags" style="margin-top:18px">${tags}</div>` : ''}
    </article>
    ${pnHtml}
    ${renderComments(s, post, extra.comments, extra.cfg)}`;
  return layout(s, { content, title: post.title, active: 'home', bodySlug: post.slug });
}

// ---------- 评论区 ----------
function commentNode(c, level) {
  const child = c.children && c.children.length
    ? `<div class="cmt-child">${c.children.map((x) => commentNode(x, level + 1)).join('')}</div>` : '';
  const who = c.is_admin ? '<span class="tag-mini">博主</span>' : '';
  const body = c.content.split('\n').map(esc).join('<br>');
  const avatarCls = c.is_admin ? ' avatar admin' : '';
  const initial = esc((c.author || '匿').trim().slice(0, 1));
  return `<div class="cmt">
    <div class="cmt-top"><span class="avatar${avatarCls}">${initial}</span>
      <div><span class="cmt-who"><b>${esc(c.author)}</b> ${who}</span><br>
      <span class="cmt-time">${fmtDate(c.created_at, true)}</span></div></div>
    <div class="cmt-body">${body}</div>
    ${child}</div>`;
}
export function renderComments(s, post, comments, cfg) {
  if (!cfg.allow) return '';
  const roots = [];
  const map = {};
  for (const c of comments) {
    c.children = [];
    map[c.id] = c;
    if (c.parent_id && map[c.parent_id]) map[c.parent_id].children.push(c);
    else roots.push(c);
  }
  const auditNote = cfg.audit ? '<p class="cmsg ok" style="display:none" id="cmsg-ok">提交成功，审核通过后将在这里显示。</p>' : '';
  const bad = '<p class="cmsg bad" style="display:none" id="cmsg-bad"></p>';
  const list = roots.length ? roots.map((c) => commentNode(c, 0)).join('') : '<p style="color:var(--muted)">暂无评论</p>';
  const form = `<div class="cform">
    <form id="cform" data-post="${esc(post.slug)}" novalidate>
      <div class="row">
        <input name="author" placeholder="昵称 *" maxlength="40" required>
        <input name="email" type="email" placeholder="邮箱（选填，仅用于博主回复联系）" maxlength="120">
      </div>
      <textarea name="content" placeholder="写下你的想法…（3–2000 字，纯文本）" required></textarea>
      <div class="hp-field" aria-hidden="true"><input name="company" tabindex="-1" autocomplete="off"></div>
      <p style="margin:12px 0 0"><button class="btn" type="submit">发表评论</button>
      ${cfg.audit ? '<span style="color:var(--muted);font-size:13px;margin-left:10px">评论将先经审核后显示</span>' : ''}</p>
      ${auditNote}${bad}
    </form></div>`;
  return `<section class="comments" id="comments">
    <h2>评论 · ${comments.length}</h2>
    ${list}
    ${form}
  </section>`;
}

// ---------- 归档 ----------
export function archiveContent(s, posts) {
  const years = {};
  for (const p of posts) {
    const d = (p.published_at || '').slice(0, 7);
    const y = d.slice(0, 4);
    (years[y] = years[y] || {})[d] = years[y][d] || [];
    years[y][d].push(p);
  }
  const yearsArr = Object.keys(years).sort((a, b) => b - a);
  if (!yearsArr.length) return '<div class="empty">还没有发布文章</div>';
  return yearsArr.map((y) => `
    <section class="arc-y"><h2>${y}</h2>
      ${Object.keys(years[y]).sort((a, b) => b - a).map((m) => `
        <div class="arc-m">${m}
          <ul>${years[y][m].map((p) => `<li><time>${(p.published_at || '').slice(0, 10)}</time><a href="/post/${esc(p.slug)}">${esc(p.title)}</a></li>`).join('')}</ul>
        </div>`).join('')}
    </section>`).join('');
}

export function render404() {
  return layout(new Map(), {
    content: `<section class="empty" style="margin-top:60px"><h1 style="font-size:40px">404</h1><p>页面不存在或已被删除。</p><a href="/">← 返回首页</a></section>`,
  });
}

// ---------- RSS / sitemap ----------
export async function rssXml(env, s, origin) {
  const data = await db.listPosts(env.DB, { status: 'published', per: 50 });
  const items = data.items.map((p) => {
    const body = (p.content_html || '').replace(/\]\]>/g, ']]&gt;');
    const cat = p.category ? `<category>${esc(p.category.name)}</category>` : '';
    return `<item>
<title>${esc(p.title)}</title>
<link>${origin}/post/${esc(p.slug)}</link>
<guid isPermaLink="false">${origin}/post/${esc(p.slug)}</guid>
<pubDate>${rfc822(p.published_at)}</pubDate>
<description><![CDATA[${body}]]></description>
${cat}
</item>`;
  }).join('\n');
  const now = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>${esc(s.get('site_title'))}</title>
<link>${origin}/</link>
<description>${esc(s.get('site_subtitle'))}</description>
<language>zh-cn</language>
<lastBuildDate>${rfc822(now)}</lastBuildDate>
<atom:link xmlns:atom="http://www.w3.org/2005/Atom" href="${origin}/rss.xml" rel="self" type="application/rss+xml"/>
${items}
</channel></rss>`;
}

export async function sitemapXml(env, s, origin) {
  const u = (loc, lastmod) => `  <url><loc>${origin}${esc(loc)}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}</url>`;
  const rows = [u('/', ''), u('/archive', '')];
  const cats = await db.listCategories(env.DB);
  for (const c of cats) rows.push(u('/category/' + esc(c.slug), ''));
  const tags = await db.listTags(env.DB);
  for (const t of tags) rows.push(u('/tag/' + esc(t.slug), ''));
  const data = await db.listPosts(env.DB, { status: 'published', per: 1000 });
  for (const p of data.items) rows.push(u('/post/' + esc(p.slug), (p.published_at || '').slice(0, 10)));
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${rows.join('\n')}
</urlset>`;
}

export function robotsTxt(origin) {
  return `User-agent: *
Allow: /
Sitemap: ${origin}/sitemap.xml
`;
}

// 预览用：后台编辑器 iframe 内嵌的文章样式文档
export function previewDoc(s, post, origin = '') {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<base href="${esc(origin)}/">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>预览</title>
<style>:root{--accent:${accentOf(s)}}${THEME_VARS}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.8 var(--font-body)}
.wrap{max-width:820px;margin:0 auto;padding:28px 22px}
h1{font-size:30px;line-height:1.4;margin:0 0 6px}
.meta{color:var(--muted);font-size:13.5px;margin-bottom:16px}
.art-body h2{font-size:23px;margin:1.6em 0 .6em;padding-left:11px;border-left:4px solid var(--accent)}
.art-body h3{font-size:19px;margin:1.5em 0 .5em}
.art-body h4{font-size:17px;margin:1.4em 0 .4em}
.art-body p{margin:0 0 1.05em}
.art-body ul,.art-body ol{margin:0 0 1.1em;padding-left:1.6em}
.art-body li{margin:.25em 0}
.art-body blockquote{margin:1.2em 0;padding:10px 18px;border-left:4px solid var(--accent);background:var(--quote-bg);border-radius:0 10px 10px 0;color:var(--quote-text)}
.art-body blockquote p{margin:.4em 0}
.art-body a{color:var(--accent);text-decoration:underline;text-underline-offset:3px}
.art-body img{max-width:100%;border-radius:10px;margin:6px 0;border:1px solid var(--line)}
.art-body hr{border:none;border-top:1px dashed var(--line);margin:2em 0}
.art-body pre{background:var(--code-bg);color:var(--code-text);padding:16px 18px;border-radius:12px;overflow:auto;font-size:14px;line-height:1.65}
.art-body code{font-family:var(--font-code);background:var(--inline-code-bg);border-radius:5px;padding:1.5px 6px;font-size:.9em}
.art-body pre code{background:none;color:inherit;padding:0;font-size:14px}
.art-body table{border-collapse:collapse;margin:1.2em 0;width:100%;font-size:15px}
.art-body th,.art-body td{border:1px solid var(--line);padding:8px 12px}
.art-body th{background:var(--tint)}
.art-body{font-size:16.5px}</style>
${themeLink(s, origin)}</head>
<body><div class="wrap"><h1>${esc(post.title || '（无标题）')}</h1>
<div class="meta">${esc(s.get('author_name'))} · ${fmtDate(new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' '), true)} · 实时预览</div>
<div class="art-body">${post.content_html}</div>
</div></body></html>`;
}

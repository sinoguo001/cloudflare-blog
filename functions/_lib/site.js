// ============================================================
// 博客前台页面渲染（Worker 端 SSR）
// 路由入口在 functions/[[path]].js，本文件只负责拼 HTML。
// ============================================================
import * as db from './db.js';
import { esc, fmtDate, rfc822, stripHtml, isHexColor, bnNow, postUrl, pageUrl } from './util.js';
import { codeThemeCss } from './hl.js';
import { gravatarHash } from './md5.js';

// Gravatar 头像源：国内优先（实测 weavatar ≈23ms、cravatar ≈88ms；官方源国内不可达）
const GRAVATAR_SRC = {
  weavatar: 'https://weavatar.com/avatar/',
  cravatar: 'https://cravatar.cn/avatar/',
  sepcc: 'https://cdn.sep.cc/avatar/',
  gravatar: 'https://www.gravatar.com/avatar/',
  secure: 'https://secure.gravatar.com/avatar/',
};
// 头像地址：邮箱 MD5（不泄露邮箱原文）+ 默认头像 mp（神秘人）
function avatarUrl(s, email, size = 80) {
  if (!email) return '';
  const base = GRAVATAR_SRC[s.get('gravatar_source')] || GRAVATAR_SRC.weavatar;
  return `${base}${gravatarHash(email)}?s=${size}&d=mp`;
}

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
.brand-img{height:36px;width:auto;max-width:170px;object-fit:contain;display:block}
.brand small{display:block;font-weight:400;font-size:12px;color:var(--muted);line-height:1.2}
.nav{display:flex;gap:4px;flex-wrap:wrap;align-items:center}
.nav a{padding:6px 12px;border-radius:8px;color:var(--text);font-size:15px}
.nav a:hover{background:var(--accent-soft);text-decoration:none}
.nav a.on{background:var(--accent);color:var(--on-accent)}
.hd-search input{padding:7px 12px;border:1px solid var(--line);border-radius:9px;font-size:14px;width:170px;outline:none}
.hd-search input:focus{border-color:var(--accent)}
/* 主区 */
.main{padding:26px 0 60px}
.hero{padding:24px 0 4px}
.hero h1{margin:0 0 12px;font-size:20px;letter-spacing:.3px;font-weight:700;color:var(--text)}
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
.pc-excerpt{margin:0 0 10px;color:var(--text-soft);font-size:15px;line-height:1.75;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
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
.art-cp{margin-top:22px;padding:13px 16px;background:var(--tint);border-left:3px solid var(--accent);border-radius:0 10px 10px 0;font-size:13.5px;line-height:1.85;color:var(--muted);word-break:break-word}
.art-cp a{color:var(--accent)}
/* 独立页面（/p/<slug>）：只留更新时间，去掉发布时间 / 分类 / 阅读数 */
.page-upd{margin:-4px 0 20px;font-size:13px;color:var(--muted)}
/* 正文排版 */
.art-body{font-size:16.5px}
.art-body h2{font-size:23px;margin:1.6em 0 .6em;padding-left:11px;border-left:4px solid var(--accent)}
.art-body h3{font-size:19px;margin:1.5em 0 .5em}
.art-body h4{font-size:17px;margin:1.4em 0 .4em}
/* 正文自然段：首行缩进 2 字符；列表/引用/表格内的段不缩进 */
.art-body>p{margin:0 0 1.05em;text-indent:2em}
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
.art-body pre{margin:1.2em 0;background:var(--code-bg);color:var(--code-text);border-radius:12px;overflow:auto}
.art-body code{font-family:var(--font-code);background:var(--inline-code-bg);border-radius:5px;padding:1.5px 6px;font-size:.9em}
.art-body pre code{background:none;color:inherit;padding:0;font-size:14px}
/* 高亮代码块：配色由后台选择的主题 CSS 提供（见 codeThemeCss），此处只管布局 */
.art-body pre code.hljs{display:block;padding:16px 18px;font-family:var(--font-code);font-size:14px;line-height:1.65;overflow:auto}
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
.avatar{width:34px;height:34px;border-radius:50%;background:var(--accent);color:var(--on-accent);display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:15px;flex:none;position:relative;overflow:hidden}
.avatar.admin{background:var(--admin)}
/* Gravatar 头像图片：盖在首字母色块上，加载失败被 onerror 移除后自动露出首字母 */
.avatar .avt{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:50%}
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
.cap-row{align-items:center;gap:10px;margin-bottom:6px}
.cap-img{width:150px;height:48px;flex:none;border:1px solid var(--line);border-radius:9px;cursor:pointer;background:var(--card);display:block}
.cap-row input{flex:1;min-width:120px;max-width:220px}
.cap-tip{font-size:12.5px;color:var(--muted);margin:0 0 12px}
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
/* 友情链接 */
.link-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px;margin-top:14px}
.link-card{display:flex;gap:12px;align-items:center;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.link-card:hover{border-color:var(--accent);text-decoration:none}
.link-logo{width:40px;height:40px;flex:none;border-radius:10px;background:var(--accent-soft);color:var(--accent);display:inline-flex;align-items:center;justify-content:center;font-weight:800;overflow:hidden}
.link-logo img{width:100%;height:100%;object-fit:contain}
.link-body{display:flex;flex-direction:column;min-width:0}
.link-body b{font-size:15px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.link-body small{color:var(--muted);font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 申请表单：前台独立样式。注意后台的 .inp / .txa 样式不会加载到前台，
   这里不能用那套 class，否则输入框会退回浏览器默认样式（此前就是这么丑的） */
.link-form{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px 24px 18px;margin-top:10px;box-shadow:0 1px 3px rgba(20,30,55,.03)}
.lf-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px 16px}
.lf-field{display:flex;flex-direction:column;gap:6px;min-width:0}
.lf-field.full,.lf-cap,.lf-foot{grid-column:1/-1}
.lf-field>label{font-size:13px;color:var(--text-soft);font-weight:600;letter-spacing:.2px}
.lf-field>label>i{color:var(--bad);font-style:normal;margin-left:3px}
.lf-input{width:100%;padding:10px 13px;border:1px solid var(--line);border-radius:10px;font-size:14.5px;font-family:inherit;color:var(--text);background:#fff;outline:none;transition:border-color .15s,box-shadow .15s}
.lf-input::placeholder{color:#9ca3af}
.lf-input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
textarea.lf-input{min-height:86px;resize:vertical;line-height:1.7}
.lf-cap .cap-wrap{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.lf-capimg{height:42px;flex:none;border-radius:10px;border:1px solid var(--line);cursor:pointer;background:#fff;display:block}
.lf-foot{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:2px}
.lf-msg{font-size:13.5px;color:var(--muted)}
.lf-msg.ok{color:var(--ok)}
.lf-msg.bad{color:var(--bad)}
.btn-p{background:var(--accent);color:#fff;border:0;border-radius:10px;padding:10px 24px;font-size:14.5px;font-weight:600;cursor:pointer}
.btn-p:hover{filter:brightness(1.06)}
.btn-p:disabled{opacity:.6;cursor:default}
/* 蜜罐：正常用户看不到也不会填，机器人填了就静默丢弃 */
.lf-hp{position:absolute!important;left:-9999px!important;width:1px;height:1px;overflow:hidden}
@media(max-width:640px){.link-form{padding:16px 14px}.lf-grid{grid-template-columns:1fr}}
.empty{background:var(--card);border:1px dashed var(--line);border-radius:12px;padding:34px;text-align:center;color:var(--muted);margin-top:18px}
/* 页脚 */
.ft{border-top:1px solid var(--line);background:var(--card);color:var(--muted);font-size:13.5px;padding:20px 0;text-align:center}
.ft a{color:var(--muted)}
.ft a:hover{text-decoration:underline}
@media (max-width:640px){
 .pc{grid-template-columns:1fr}.pc-cover img{width:100%;height:auto;max-height:180px}
 .article{padding:22px 18px}.comments{padding:20px 18px}.cmt-child{margin-left:20px}
 .hd-search input{width:100%}
}
`;

// ---------- 站点标识（logo / favicon）----------
// 图标字符：站点标题首字，取不到时回退品牌字「云」，保证各页面（含 404）永远一致。
export function brandChar(s) {
  return (String(s.get('site_title') || '').trim()[0] || '云');
}
// 页头标识：设了 logo_image 用图片，否则用文字方块（按钮式方形 + 首字）
function brandMark(s) {
  const img = String(s.get('logo_image') || '').trim();
  return img ? `<img class="brand-img" src="${esc(img)}" alt="">` : `<span class="brand-mark">${esc(brandChar(s))}</span>`;
}
// 自定义图标地址：favicon 优先用 favicon_image，没设则复用 logo_image，都没设则用动态 /favicon.svg
export function faviconHref(s) {
  return String(s.get('favicon_image') || s.get('logo_image') || '/favicon.svg').trim();
}
export function faviconMime(href) {
  return /\.svg(\?|$)/i.test(href) ? 'image/svg+xml'
    : /\.png(\?|$)/i.test(href) ? 'image/png'
    : /\.jpe?g(\?|$)/i.test(href) ? 'image/jpeg'
    : /\.webp(\?|$)/i.test(href) ? 'image/webp'
    : /\.ico(\?|$)/i.test(href) ? 'image/x-icon' : '';
}
// 动态 favicon：与页头 .brand-mark 同源（同色、同字），改站点名或主题色自动跟随
export function faviconSvg(s) {
  const ch = esc(brandChar(s));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<rect width="64" height="64" rx="14" fill="${accentOf(s)}"/>
<text x="32" y="33" text-anchor="middle" dominant-baseline="central" font-size="38" font-weight="700"
 fill="#fff" font-family="system-ui,-apple-system,'Segoe UI','Microsoft YaHei',sans-serif">${ch}</text>
</svg>`;
}

// ---------- 页面骨架 ----------
export function layout(s, o) {
  const title = s.get('site_title');
  const accent = accentOf(s);
  const desc = o.desc || s.get('seo_desc') || s.get('site_subtitle');
  const year = new Date(Date.now() + 8 * 3600e3).getUTCFullYear();
  const footer = (s.get('footer_text') || '').split('\n').map(esc).join('<br>');
  const beian = (s.get('beian') || '').trim(); // ICP 备案号：填了才在页脚显示，链工信部官网
  const nav = (href, label, key) =>
    `<a href="${href}"${o.active === key ? ' class="on"' : ''}>${esc(label)}</a>`;
  // 独立页面入口：路由层把当前请求查到的页面列表塞进 s（键名带下划线，不会落库），
  // 这样每个请求各用自己的数据，不靠模块级全局变量，避免并发请求互相串。
  let navPages = [];
  try {
    const raw = JSON.parse(s.get('_nav_pages') || '[]');
    if (Array.isArray(raw)) navPages = raw;
  } catch (e) { navPages = []; }
  const navPagesHtml = navPages
    .map((p) => nav(pageUrl(p), p.title, 'p:' + p.slug)).join('');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${o.title ? esc(o.title) + ' · ' + esc(title) : esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="icon" href="${esc(faviconHref(s))}"${faviconMime(faviconHref(s)) ? ` type="${faviconMime(faviconHref(s))}"` : ''}>
<link rel="alternate" type="application/rss+xml" title="${esc(title)}" href="/rss.xml">
<style>:root{--accent:${accent}}${THEME_VARS}${FRONT_CSS}${codeThemeCss(s.get('code_theme'))}</style>
${themeLink(s)}
<!-- 全站加载：文章页用它上报阅读量，所有页面用它上报 PV（后台是独立静态页，不走这里） -->
<script src="/js/site.js" defer></script>
</head>
<body data-slug="${o.bodySlug || ''}">
<header class="hd"><div class="wrap hd-in">
  <a class="brand" href="/">${brandMark(s)}
    <span>${esc(title)}<small>${esc(s.get('site_subtitle'))}</small></span></a>
  <nav class="nav">
    ${nav('/', '首页', 'home')}
    ${nav('/categories', '分类', 'cat')}
    ${nav('/tags', '标签', 'tags')}
    ${nav('/archive', '归档', 'arc')}
    ${nav('/links', '友链', 'links')}
    ${navPagesHtml}
    ${nav('/rss.xml', 'RSS', 'rss')}
  </nav>
  <form class="hd-search" action="/search" method="get"><input name="q" placeholder="搜索文章…" value="${o.q ? esc(o.q) : ''}"></form>
</div></header>
<main class="main"><div class="wrap">${o.content}</div></main>
<footer class="ft"><div class="wrap">
  ${footer ? footer + '<br>' : ''}© ${year} ${esc(title)} · 由 Cloudflare Pages 驱动
  ${beian ? `<br><a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">${esc(beian)}</a>` : ''}
</div></footer>
</body>
</html>`;
}

// ---------- 通用片段 ----------
function catChips(list, base = '/category') {
  if (!list.length) return '';
  return `<div class="chips">${list.map((c) => `<a class="chip" href="${base}/${esc(c.slug)}">${esc(c.name)}<b> ${c.count || 0}</b></a>`).join('')}</div>`;
}
// p 之后可传设置 Map s；传了就用「永久链接」规则生成地址，否则退回 /post/:slug
function postCard(p, s) {
  const url = esc(s ? postUrl(s, p) : '/post/' + p.slug);
  const cover = p.cover_key
    ? `<div class="pc-cover"><a href="${url}"><img src="/media/${esc(p.cover_key)}" alt="" loading="lazy"></a></div>` : '';
  const cat = p.category ? `<a href="/category/${esc(p.category.slug)}">${esc(p.category.name)}</a>` : '';
  const excerpt = p.excerpt || stripHtml(p.content_html).slice(0, 260);
  const tags = (p.tags || []).map((t) => `<a class="tag-chip" href="/tag/${esc(t.slug)}">${esc(t.name)}</a>`).join('');
  return `<article class="pc${cover ? '' : ' no-cover'}"><div>
    <div class="pc-meta">
      <time>${fmtDate(p.published_at || p.created_at)}</time>
      ${cat ? `<span class="dot">·</span>${cat}` : ''}
      <span class="dot">·</span><span>阅读 ${p.view_count || 0}</span>
      <span class="dot">·</span><span>${p.comment_count || 0} 评论</span>
    </div>
    <h2 class="pc-title"><a href="${url}">${esc(p.title)}</a></h2>
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
  // ⚠️ 必须写成箭头函数：map 会把下标当第二个参数传进来，直接传 postCard 会把 s 顶掉
  const items = data.items.map((p) => postCard(p, s)).join('');
  const content = `
    <section class="hero"><h1>最新文章</h1></section>
    ${catChips(data.categories)}
    ${items ? `<div class="plist">${items}</div>` + pagination(page, data.pages, '/', 1)
      : `<div class="empty">还没有发布文章</div>`}
    ${pagination(page, data.pages, '/', 1) ? '' : ''}`;
  return layout(s, { content, active: 'home', bodySlug: '' });
}

export function renderListPage(s, o) {
  // o: {head, desc, itemsHtml, page, pages, base}
  return layout(s, {
    active: o.active, q: o.q, title: o.title,
    content: `<section class="page-head"><h1>${o.head}</h1>${o.desc ? `<p class="desc">${o.desc}</p>` : ''}${o.extra || ''}</section>
    ${o.itemsHtml ? `<div class="plist">${o.itemsHtml}</div>` : (o.extra ? '' : `<div class="empty">${o.empty || '暂无内容'}</div>`)}
    ${pagination(o.page, o.pages, o.base, o.pageSize)}`,
  });
}

// ---------- 文章版权说明 ----------
// 后台「文章设置 → 版权说明」留空则整块不渲染；填了才在正文下方显示。
// 内容为纯文本模板：先替换变量、再整体转义（不支持 HTML，防注入），换行转 <br>。
export function copyrightHtml(s, post, origin) {
  const tpl = String(s.get('copyright') || '').trim();
  if (!tpl) return '';
  const rel = postUrl(s, post);
  const map = {
    title: post.title || '',
    url: (origin || '') + rel,
    link: rel,
    author: s.get('author_name') || '',
    date: (post.published_at || '').slice(0, 10),
    year: (post.published_at || '').slice(0, 4),
    site: s.get('site_title') || '',
    siteUrl: origin || '',
    category: post.category ? post.category.name : '',
  };
  const text = tpl.replace(/\{(title|url|link|author|date|year|site|siteUrl|category)\}/g,
    (m, k) => (map[k] || m));
  return `<div class="art-cp">${text.split('\n').map(esc).join('<br>')}</div>`;
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
    ${pn.prev ? `<a href="${esc(postUrl(s, pn.prev))}"><small>← 上一篇</small>${esc(pn.prev.title)}</a>` : '<span></span>'}
    ${pn.next ? `<a class="next" href="${esc(postUrl(s, pn.next))}"><small>下一篇 →</small>${esc(pn.next.title)}</a>` : '<span></span>'}
  </nav>`;
  const content = `
    <p class="crumb"><a href="/">首页</a> / ${post.category ? `<a href="/category/${esc(post.category.slug)}">${esc(post.category.name)}</a> / ` : ''}正文</p>
    <article class="article">
      <h1>${esc(post.title)}</h1>
      <div class="art-meta">${meta}</div>
      ${cover}
      <div class="art-body">${post.content_html}</div>
      ${tags ? `<div class="pc-tags" style="margin-top:18px">${tags}</div>` : ''}
      ${copyrightHtml(s, post, extra.origin)}
    </article>
    ${pnHtml}
    ${renderComments(s, post, extra.comments, extra.cfg)}`;
  return layout(s, { content, title: post.title, active: 'home', bodySlug: post.slug });
}

// 独立页面（Ver 0.4）：只有标题与正文 —— 不带发布时间、分类、阅读数、标签、评论、
// 上下篇与版权声明；bodySlug 留空，前端也就不会上报阅读量。
export function renderPage(s, post) {
  const upd = post.updated_at
    ? `<p class="page-upd">最后更新：${fmtDate(post.updated_at, true)}</p>` : '';
  const content = `
    <article class="article">
      <h1>${esc(post.title)}</h1>
      ${upd}
      <div class="art-body">${post.content_html}</div>
    </article>`;
  return layout(s, {
    content, title: post.title, active: 'p:' + post.slug,
    desc: post.excerpt || '', bodySlug: '',
  });
}

// ---------- 评论区 ----------
function commentNode(c, level, s) {
  const child = c.children && c.children.length
    ? `<div class="cmt-child">${c.children.map((x) => commentNode(x, level + 1, s)).join('')}</div>` : '';
  const who = c.is_admin ? '<span class="tag-mini">博主</span>' : '';
  const body = c.content.split('\n').map(esc).join('<br>');
  const avatarCls = c.is_admin ? ' avatar admin' : '';
  const initial = esc((c.author || '匿').trim().slice(0, 1));
  // Gravatar 头像：按邮箱 MD5 取图；加载失败自动移除，回退为首字母色块
  const av = avatarUrl(s, c.email, 80);
  const avatarHtml = `<span class="avatar${avatarCls}">${initial}${
    av ? `<img class="avt" src="${esc(av)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''
  }</span>`;
  // 网址选填：填了合法 http(s) 地址，昵称即可点击跳转（nofollow，防垃圾链接权重传递）
  const web = /^https?:\/\/[^\s]+$/i.test(String(c.website || '').trim()) ? String(c.website).trim() : '';
  const name = web
    ? `<a href="${esc(web)}" target="_blank" rel="noopener nofollow ugc" style="color:inherit;text-decoration:underline">${esc(c.author)}</a>`
    : esc(c.author);
  return `<div class="cmt">
    <div class="cmt-top">${avatarHtml}
      <div><span class="cmt-who"><b>${name}</b> ${who}</span><br>
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
  const list = roots.length ? roots.map((c) => commentNode(c, 0, s)).join('') : '<p style="color:var(--muted)">暂无评论</p>';
  const form = `<div class="cform">
    <form id="cform" data-post="${esc(post.slug)}" novalidate>
      <div class="row">
        <input name="author" placeholder="昵称 *" maxlength="40" required>
        <input name="email" type="email" placeholder="邮箱 *（用于显示头像，不公开）" maxlength="120" required>
        <input name="website" type="url" placeholder="网址（选填，展示在昵称上）" maxlength="200">
      </div>
      <textarea name="content" placeholder="写下你的想法…（3–2000 字，纯文本）" required></textarea>
      ${cfg.captcha === false ? '' : `<div class="row cap-row">
        <img id="capimg" class="cap-img" src="/api/captcha" alt="算术验证码" title="点击换一张">
        <input name="captcha" placeholder="图片算式的答案 *" maxlength="6" autocomplete="off" required>
      </div>
      <p class="cap-tip">看不清？点击图片换一道题。</p>`}
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
  // 无文章时返回空串：空态交给 renderListPage 统一渲染（否则归档页会同时出现列表和「还没有发布文章」）
  if (!yearsArr.length) return '';
  return yearsArr.map((y) => `
    <section class="arc-y"><h2>${y}</h2>
      ${Object.keys(years[y]).sort((a, b) => b - a).map((m) => `
        <div class="arc-m">${m}
          <ul>${years[y][m].map((p) => `<li><time>${(p.published_at || '').slice(0, 10)}</time><a href="${esc(postUrl(s, p))}">${esc(p.title)}</a></li>`).join('')}</ul>
        </div>`).join('')}
    </section>`).join('');
}

// ---------- 分类 / 标签总览页 ----------
// 导航栏「分类」「标签」指向 /categories 与 /tags，此前这两个页面根本不存在（点进去是 404，
// 页头还因拿不到设置而退化成兜底字）——现在补齐。
export function renderCategories(s, list) {
  return layout(s, {
    title: '全部分类', active: 'cat',
    desc: `${String(s.get('site_title') || '').trim()} 的全部分类`,
    content: `<section class="article">
      <h1 style="margin:0 0 6px">全部分类</h1>
      <p style="color:var(--muted);margin:0 0 18px">共 ${list.length} 个分类</p>
      ${list.length ? catChips(list, '/category') : '<p style="color:var(--muted)">还没有创建分类。</p>'}
    </section>`,
  });
}
export function renderTags(s, list) {
  return layout(s, {
    title: '全部标签', active: 'tags',
    desc: `${String(s.get('site_title') || '').trim()} 的全部标签`,
    content: `<section class="article">
      <h1 style="margin:0 0 6px">全部标签</h1>
      <p style="color:var(--muted);margin:0 0 18px">共 ${list.length} 个标签</p>
      ${list.length ? catChips(list, '/tag') : '<p style="color:var(--muted)">还没有创建标签。</p>'}
    </section>`,
  });
}

// ---------- 友情链接 ----------
// 只展示 status='approved' 的条目；右侧是读者申请表单（提交后由后台审核）。
// 申请接口是公开的，靠蜜罐 + 算术验证码 + 同 IP 频控防刷（见 [[path]].js 的 /api/link-apply）。
function linkCard(l) {
  const ch = (String(l.name || '').trim()[0] || '?').toUpperCase();
  // 站点图标：填了 logo 用图片，否则用名称首字方块，与页头标识同款处理
  const logo = l.logo
    ? `<img src="${esc(l.logo)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
    : esc(ch);
  return `<a class="link-card" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">
    <span class="link-logo">${logo}</span>
    <span class="link-body"><b>${esc(l.name)}</b>
      <small>${esc(l.description || l.url)}</small></span>
  </a>`;
}
export function renderLinks(s, { links = [], captcha = true } = {}) {
  const grid = links.length
    ? `<div class="link-grid">${links.map(linkCard).join('')}</div>`
    : '<p style="color:var(--muted)">还没有友情链接，欢迎在下方申请互换。</p>';
  const capHtml = captcha
    ? `<div class="lf-field lf-cap">
         <label for="lk-captcha">验证码 <i>*</i></label>
         <div class="cap-wrap">
           <input class="lf-input" name="captcha" id="lk-captcha" placeholder="请输入算式结果" autocomplete="off" style="flex:1;min-width:120px;max-width:190px">
           <img class="lf-capimg" id="lk-capimg" src="/api/captcha" alt="验证码" title="点击换一张">
           <span class="lf-msg">看不清？点图片换一张</span>
         </div>
       </div>` : '';
  return layout(s, {
    title: '友情链接', active: 'links',
    desc: `${String(s.get('site_title') || '').trim()} 的友情链接`,
    content: `<section class="article">
      <h1 style="margin:0 0 6px">友情链接</h1>
      <p style="color:var(--muted);margin:0 0 18px">共 ${links.length} 个站点 · 想互换友链？在页面底部提交申请即可。</p>
      ${grid}

      <h2 style="margin:32px 0 6px;font-size:19px">申请添加友链</h2>
      <p style="color:var(--muted);margin:0 0 14px">提交后由站长审核，通过后会展示在上面。请确保你的站点可以正常访问。</p>
      <form class="link-form" id="lk-form">
        <div class="lf-grid">
          <div class="lf-field">
            <label for="lk-name">站点名称 <i>*</i></label>
            <input class="lf-input" id="lk-name" name="name" maxlength="40" required placeholder="例如：云尚博客">
          </div>
          <div class="lf-field">
            <label for="lk-url">站点地址 <i>*</i></label>
            <input class="lf-input" id="lk-url" name="url" maxlength="300" required placeholder="https://example.com">
          </div>
          <div class="lf-field full">
            <label for="lk-desc">一句话简介</label>
            <input class="lf-input" id="lk-desc" name="description" maxlength="120" placeholder="选填，展示在名称下方">
          </div>
          <div class="lf-field">
            <label for="lk-logo">图标地址</label>
            <input class="lf-input" id="lk-logo" name="logo" maxlength="300" placeholder="选填，正方形图片地址">
          </div>
          <div class="lf-field">
            <label for="lk-contact">联系方式</label>
            <input class="lf-input" id="lk-contact" name="contact" maxlength="80" placeholder="选填，仅站长可见">
          </div>
          <div class="lf-field full">
            <label for="lk-reason">申请留言</label>
            <textarea class="lf-input" id="lk-reason" name="reason" maxlength="300" placeholder="选填，仅站长可见。可以简单介绍一下你的站点"></textarea>
          </div>
          <!-- 蜜罐字段：正常用户看不到也不会填，机器人填了就静默丢弃 -->
          <div class="lf-hp" aria-hidden="true"><label>公司名称</label><input name="company" tabindex="-1" autocomplete="off"></div>
          ${capHtml}
          <div class="lf-foot">
            <button class="btn-p" type="submit" id="lk-submit">提交申请</button>
            <span class="lf-msg" id="lk-msg"></span>
          </div>
        </div>
      </form>
    </section>`,
  });
}

export function render404(s) {
  return layout(s || new Map(), {
    content: `<section class="empty" style="margin-top:60px"><h1 style="font-size:40px">404</h1><p>页面不存在或已被删除。</p><a href="/">← 返回首页</a></section>`,
  });
}

// ============================================================
// RSS / Sitemap
// 阅读器与搜索引擎拿标准 XML（rssXml / sitemapXml）；
// 浏览器直接打开 URL 时拿排版好的 HTML（rssHtml / sitemapHtml，
// 由 [[path]].js 按 Accept / UA 判别）。Chrome 2026-11 起移除浏览器端
// XSLT，故不再依赖 xml-stylesheet，改为服务端直接拼页面。
// ============================================================

const FEED_CSS = `
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;padding:36px 18px;background:#eef1f6;color:#1f2937;
  font:15px/1.75 -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif}
.page{max-width:880px;margin:0 auto}
.card{background:#fff;border:1px solid #e6e9ef;border-radius:18px;box-shadow:0 2px 14px rgba(20,30,55,.05);overflow:hidden}
header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:26px 30px 20px;border-bottom:1px solid #eef0f4}
h1{margin:0;font-size:22px;font-weight:700;letter-spacing:.2px}
.ico{margin-right:9px}
.sub{margin:4px 0 0;color:#6b7280;font-size:13.5px}
.go{white-space:nowrap;flex:none;text-decoration:none;color:#2563eb;font-size:13.5px;border:1px solid #dbe4f6;background:#f6f8ff;padding:5px 13px;border-radius:999px;margin-top:2px}
.go:hover{background:#e8eefe}
.bar{padding:11px 30px;background:#fafbfd;color:#6b7280;font-size:13px;border-bottom:1px solid #f0f2f6}
.bar b{color:#2563eb;font-weight:700}
.items{padding:8px 14px}
.it{display:block;padding:17px 16px;border-bottom:1px solid #f2f4f8;text-decoration:none}
.it:last-child{border-bottom:none}
.it:hover{background:#f8faff}
.it .t{font-size:16.5px;font-weight:650;color:#1f2937;line-height:1.55;text-decoration:none}
.it:hover .t{color:#2563eb}
.it .m{margin-top:5px;color:#818a97;font-size:13.5px;line-height:1.7;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.it time{color:#2563eb;font-size:12.5px;margin-right:10px}
table{width:100%;border-collapse:collapse}
th{font-size:12.5px;color:#8a93a0;font-weight:600;text-align:left;padding:13px 30px 8px;letter-spacing:.4px}
td{padding:10px 30px;border-top:1px solid #f2f4f8;vertical-align:middle}
tbody tr:hover{background:#f8faff}
td.path{font-size:14.5px;word-break:break-all}
td.path a{color:#1f2937;text-decoration:none}
td.path a:hover{color:#2563eb}
td.path .host{color:#a3abb6;font-size:12.5px;margin-right:6px}
td.time{color:#818a97;font-size:13px;white-space:nowrap}
.tag{display:inline-block;font-size:11.5px;padding:1px 9px;border-radius:999px;margin-right:13px;white-space:nowrap;background:#eef2ff;color:#2563eb}
.tag.h{background:#eefdf3;color:#0a9a5f}
.tag.c{background:#fef3f2;color:#d6453d}
.tag.a{background:#fdf5ec;color:#d97706}
.tag.t{background:#f3eefe;color:#7c4dd3}
.empty{padding:30px;color:#9aa1ac;text-align:center}
footer{padding:16px 30px 22px;color:#9aa1ac;font-size:12.5px}
footer a{color:#2563eb;text-decoration:none}
@media (max-width:640px){body{padding:16px 10px}.items{padding:8px 6px}.it{padding:15px 12px}th,td{padding-left:16px;padding-right:16px}}
`;

// RSS / Sitemap 页面共用骨架
function feedLayout({ icon, title, sub, home, bar, body, foot }) {
  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>${FEED_CSS}</style>
</head><body>
<div class="page"><div class="card">
<header>
  <div>
    <h1><span class="ico">${icon}</span>${esc(title)}</h1>
    ${sub ? `<div class="sub">${esc(sub)}</div>` : ''}
  </div>
  <a class="go" href="${home}">返回博客 ↗</a>
</header>
${bar ? `<div class="bar">${bar}</div>` : ''}
${body}
<footer>${foot}</footer>
</div></div>
</body></html>`;
}

// 浏览器直接打开 /rss.xml 时展示的排版页
export async function rssHtml(env, s, origin) {
  const data = await db.listPosts(env.DB, { status: 'published', per: 50 });
  const now = bnNow(); // UTC+8 'YYYY-MM-DD HH:MM:SS'
  const siteTitle = s.get('site_title') || '云尚博客';
  const items = data.items.map((p) => {
    const body = p.content_html || '';
    const ex = esc((p.excerpt || stripHtml(body).slice(0, 220)) || '（无摘要）');
    const d = p.published_at ? fmtDate(p.published_at) : '';
    return `<a class="it" href="${origin}${esc(postUrl(s, p))}">
  <span class="t">${esc(p.title)}</span>
  <div class="m">${d ? `<time>${d}</time>` : ''}${ex}</div>
</a>`;
  }).join('\n');
  return feedLayout({
    icon: '📡',
    title: `RSS 订阅 · ${siteTitle}`,
    sub: s.get('site_subtitle') || '',
    home: origin + '/',
    bar: `最近 <b>${data.items.length}</b> 篇文章 · 更新于 ${esc(now.slice(0, 10))}`,
    body: items ? `<div class="items">${items}</div>` : '<div class="empty">还没有文章</div>',
    foot: `此页面由服务器直接生成，仅供浏览器阅读；订阅器请使用原始地址。
<a href="${origin}/rss.xml?format=xml">RSS 源</a> · <a href="${origin}/sitemap.xml">站点地图</a> · <a href="${origin}">回到首页</a>`,
  });
}

// 浏览器直接打开 /sitemap.xml 时展示的排版页
export async function sitemapHtml(env, s, origin) {
  const tag = (text, cls) => `<span class="tag${cls ? ' ' + cls : ''}">${esc(text)}</span>`;
  const u = (path, type, cls, mod) => {
    const loc = origin + path;
    let host = '';
    try { host = new URL(loc).host; } catch (e) { /* 忽略 */ }
    return `<tr>
  <td>${tag(type, cls)}</td>
  <td class="path"><a href="${esc(loc)}"><span class="host">${esc(host)}</span>${esc(path)}</a></td>
  <td class="time">${mod ? esc(mod) : ''}</td>
</tr>`;
  };
  const rows = [];
  rows.push(u('/', '首页', 'h', ''));
  rows.push(u('/archive', '归档', '', ''));
  const cats = await db.listCategories(env.DB);
  for (const c of cats) rows.push(u('/category/' + c.slug, '分类', 'c', ''));
  const tags = await db.listTags(env.DB);
  for (const t of tags) rows.push(u('/tag/' + t.slug, '标签', 't', ''));
  const data = await db.listPosts(env.DB, { status: 'published', per: 1000 });
  for (const p of data.items) rows.push(u(postUrl(s, p), '文章', 'a', (p.published_at || '').slice(0, 10)));
  // 独立页面同样进站点地图：搜索引擎要能抓到「关于我」这类页面
  const pages = await db.listPages(env.DB);
  for (const p of pages) rows.push(u(pageUrl(p), '页面', 'p', (p.published_at || '').slice(0, 10)));
  return feedLayout({
    icon: '🗺️',
    title: '站点地图',
    sub: '本站全部页面入口 · XML Sitemap 供搜索引擎抓取，此页仅供浏览',
    home: origin + '/',
    bar: `共 <b>${rows.length}</b> 个链接`,
    body: rows.length
      ? `<table><thead><tr><th></th><th>页面</th><th>最后更新</th></tr></thead><tbody>${rows.join('\n')}</tbody></table>`
      : '<div class="empty">暂无内容</div>',
    foot: `此页面由服务器直接生成，仅供浏览器阅读；搜索引擎请使用原始地址。
<a href="${origin}/sitemap.xml?format=xml">Sitemap 源</a> · <a href="${origin}/rss.xml">RSS 订阅</a> · <a href="${origin}">回到首页</a>`,
  });
}

// ---------- XML（给阅读器与搜索引擎的标准数据）----------
export async function rssXml(env, s, origin) {
  const data = await db.listPosts(env.DB, { status: 'published', per: 50 });
  const items = data.items.map((p) => {
    const body = (p.content_html || '').replace(/\]\]>/g, ']]&gt;');
    const cat = p.category ? `<category>${esc(p.category.name)}</category>` : '';
    return `<item>
<title>${esc(p.title)}</title>
<link>${origin}${esc(postUrl(s, p))}</link>
<guid isPermaLink="false">${origin}${esc(postUrl(s, p))}</guid>
<pubDate>${rfc822(p.published_at)}</pubDate>
<description><![CDATA[${body}]]></description>
${cat}
</item>`;
  }).join('\n');
  const now = bnNow();
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
  const rows = [u('/', ''), u('/archive', ''), u('/categories', ''), u('/tags', ''), u('/links', '')];
  const cats = await db.listCategories(env.DB);
  for (const c of cats) rows.push(u('/category/' + esc(c.slug), ''));
  const tags = await db.listTags(env.DB);
  for (const t of tags) rows.push(u('/tag/' + esc(t.slug), ''));
  const data = await db.listPosts(env.DB, { status: 'published', per: 1000 });
  for (const p of data.items) rows.push(u(postUrl(s, p), (p.published_at || '').slice(0, 10)));
  const pages = await db.listPages(env.DB);
  for (const p of pages) rows.push(u(pageUrl(p), (p.published_at || '').slice(0, 10)));
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
.art-body>p{margin:0 0 1.05em;text-indent:2em}
.art-body p{margin:0 0 1.05em}
.art-body ul,.art-body ol{margin:0 0 1.1em;padding-left:1.6em}
.art-body li{margin:.25em 0}
.art-body blockquote{margin:1.2em 0;padding:10px 18px;border-left:4px solid var(--accent);background:var(--quote-bg);border-radius:0 10px 10px 0;color:var(--quote-text)}
.art-body blockquote p{margin:.4em 0}
.art-body a{color:var(--accent);text-decoration:underline;text-underline-offset:3px}
.art-body img{max-width:100%;border-radius:10px;margin:6px 0;border:1px solid var(--line)}
.art-body hr{border:none;border-top:1px dashed var(--line);margin:2em 0}
.art-body pre{margin:1.2em 0;background:var(--code-bg);color:var(--code-text);border-radius:12px;overflow:auto}
.art-body code{font-family:var(--font-code);background:var(--inline-code-bg);border-radius:5px;padding:1.5px 6px;font-size:.9em}
.art-body pre code{background:none;color:inherit;padding:0;font-size:14px}
/* 高亮代码块：配色由后台选择的主题 CSS 提供（见 codeThemeCss），此处只管布局 */
.art-body pre code.hljs{display:block;padding:16px 18px;font-family:var(--font-code);font-size:14px;line-height:1.65;overflow:auto}
.art-body table{border-collapse:collapse;margin:1.2em 0;width:100%;font-size:15px}
.art-body th,.art-body td{border:1px solid var(--line);padding:8px 12px}
.art-body th{background:var(--tint)}
.art-body{font-size:16.5px}${codeThemeCss(s.get('code_theme'))}</style>
${themeLink(s, origin)}</head>
<body><div class="wrap"><h1>${esc(post.title || '（无标题）')}</h1>
<div class="meta">${esc(s.get('author_name'))} · ${fmtDate(new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' '), true)} · 实时预览</div>
<div class="art-body">${post.content_html}</div>
</div></body></html>`;
}

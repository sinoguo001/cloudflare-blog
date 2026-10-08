// ============================================================
// 博客前台页面渲染（Worker 端 SSR）
// 路由入口在 functions/[[path]].js，本文件只负责拼 HTML。
// ============================================================
import * as db from './db.js';
import { esc, fmtDate, rfc822, stripHtml, isHexColor, bnNow, postUrl, pageUrl, catUrl } from './util.js';
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

// 主题色配套色：主色一改，浅底 / 极浅底 / 主色上的文字色必须跟着变，
// 否则会出现「红按钮配蓝底」「深色主色上写白字看不清」这类半变不变的样子。
// 混白比例与后台 applyAccent 保持一致，两边观感才统一。
export function accentVars(hex) {
  const c = isHexColor(hex) ? hex : ACCENT;
  const r = parseInt(c.slice(1, 3), 16), g = parseInt(c.slice(3, 5), 16), b = parseInt(c.slice(5, 7), 16);
  const mix = (t) => `rgb(${Math.round(r + (255 - r) * t)},${Math.round(g + (255 - g) * t)},${Math.round(b + (255 - b) * t)})`;
  // sRGB 相对亮度：亮色主色上用深色字，暗色主色上用白字
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return `--accent:${c};--accent-soft:${mix(0.92)};--tint:${mix(0.94)};--on-accent:${lum > 0.62 ? '#1f2937' : '#fff'}`;
}

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

// ---------- 夜间模式（Ver 0.4 ⑧） ----------
// 关键：选择器写成 html[data-theme="dark"] 而不是 :root。
// 属性选择器特异性（0,1,1）高于 :root（0,1,0），所以无论主题的 style.css 在它之前还是
// 之后加载、无论用户装的是哪套主题，这套暗色变量都能压住对方 —— 换主题也一样生效。
// 不覆盖 --accent：主题色是用户在后台设的，夜里也照用（只把配套底色换成暗色）。
export const DARK_VARS = `
html[data-theme="dark"]{
--bg:#0e1219;--card:#161d29;--text:#dbe4f0;--text-soft:#a8b6c9;--muted:#76879d;
--accent-soft:#1d2c47;--tint:#1f2937;--on-accent:#0b1220;
--quote-bg:#1b2434;--quote-text:#c4d2e4;--code-bg:#080c13;--code-text:#cfe3ff;--inline-code-bg:#243047;
--line:#2a3548;--admin:#c084fc;--admin-soft:#33244d;--admin-text:#d8b4fe;--ok:#4ade80;--bad:#f87171}
/* 暗底上输入框要跟着变，否则白底黑字在夜里像贴了块膏药 */
html[data-theme="dark"] .hd-search input,html[data-theme="dark"] .cform input,
html[data-theme="dark"] .cform textarea,html[data-theme="dark"] .lock-inp{background:var(--card);color:var(--text);border-color:var(--line)}
html[data-theme="dark"] .pc-cover img,html[data-theme="dark"] .art-cover img{background:var(--card)}
/* 切换按钮：白天露太阳、夜里露月亮 */
.theme-btn,.search-btn{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;padding:0;
  border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--muted);cursor:pointer}
.theme-btn:hover,.search-btn:hover{border-color:var(--accent);color:var(--accent);text-decoration:none}
.theme-btn svg,.search-btn svg{width:20px;height:20px;display:block}
/* 展开后搜索图标变成「关闭」（×），再点一下收起 */
.search-btn .ico-close{display:none}
.search-btn.on{border-color:var(--accent);color:var(--accent)}
.search-btn.on .ico-search{display:none}
.search-btn.on .ico-close{display:block}
html[data-theme="dark"] .ico-sun,html[data-theme="light"] .ico-moon{display:none}
`;

// ---------- 全站灰度（Ver 0.4 ⑨） ----------
// 类选择器 + !important：装了任何主题、主题里写了什么 filter，都压不住它。
// 只加在 <html> 上，一次过滤整棵子树（含图片与代码块）；Safari 需要 -webkit- 前缀。
export const GRAY_CSS = `
html.gray{-webkit-filter:grayscale(1)!important;filter:grayscale(1)!important}
`;

// ---------- 侧边栏（Ver 0.5 ②）----------
// 默认关闭（后台「设置 → 侧边栏」开启）。关闭时前台结构与以前完全一样（单栏），
// 这段样式也压根不会输出；开启后正文与侧边栏两列。
// 窄屏（≤960px）自动退回单栏：侧边栏落在正文下方，不会挤坏手机上的阅读。
// ⚠️ .wrap 只在开启时加 .wide 才变宽 —— 没开侧边栏的站点页面宽度与旧版逐像素一致。
// 布局全部用 CSS 变量取色，因此夜间模式与换主题同样生效。
export const SIDEBAR_CSS = `
.wrap.wide{max-width:1200px}
.ly{display:grid;grid-template-columns:minmax(0,1fr);gap:24px;align-items:start}
@media(min-width:961px){
  .ly.sd-right{grid-template-columns:minmax(0,1fr) 296px}
  .ly.sd-left{grid-template-columns:296px minmax(0,1fr)}
  /* DOM 里正文在前（利于阅读与无障碍），靠 order 把侧边栏换到左边 */
  .ly.sd-left .sd{order:-1}
}
.sd{display:grid;gap:16px;align-content:start}
.sd-w{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:15px 17px}
.sd-t{margin:0 0 10px;font-size:14.5px;font-weight:700;color:var(--text);
  display:flex;align-items:center;gap:7px;letter-spacing:.3px}
.sd-t::before{content:"";width:3px;height:13px;border-radius:2px;background:var(--accent);flex:none}
.sd-list{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.sd-i{display:flex;align-items:baseline;gap:8px;font-size:14px;line-height:1.55;min-width:0}
.sd-i a{color:var(--text);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sd-i a:hover{color:var(--accent)}
.sd-n{flex:none;width:19px;height:19px;border-radius:6px;background:var(--accent-soft);color:var(--accent);
  font-size:11.5px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;font-variant-numeric:tabular-nums}
.sd-c{flex:none;font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}
/* 标签云：字号由服务端按文章数算好后写进行内 style，这里只管排布 */
.sd-cloud{display:flex;flex-wrap:wrap;gap:7px 9px;align-items:baseline}
.sd-tag{color:var(--accent);background:var(--accent-soft);border-radius:999px;padding:2px 10px;line-height:1.7}
.sd-tag:hover{background:var(--accent);color:var(--on-accent);text-decoration:none}
/* 最新评论 */
.sd-cmts{list-style:none;margin:0;padding:0;display:grid;gap:11px}
.sd-cmt{display:grid;gap:2px;font-size:13.5px;min-width:0}
.sd-who{color:var(--text-soft);font-weight:600;display:flex;align-items:center;gap:6px}
.sd-adm{font-style:normal;font-size:11px;background:var(--admin-soft);color:var(--admin-text);padding:0 6px;border-radius:999px}
.sd-say{color:var(--muted);line-height:1.65;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}
.sd-on{color:var(--muted);font-size:12.5px}
.sd-on:hover{color:var(--accent)}
/* 站点统计 */
.sd-stats{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.sd-stat{background:var(--tint);border-radius:10px;padding:8px 10px;display:grid;gap:1px}
.sd-stat b{font-size:17px;line-height:1.2;color:var(--accent);font-variant-numeric:tabular-nums}
.sd-stat span{font-size:12px;color:var(--muted)}
/* 搜索 */
.sd-search{display:flex;gap:8px}
.sd-search input{flex:1;min-width:0;padding:8px 11px;border:1px solid var(--line);border-radius:9px;
  font-size:14px;background:var(--bg);color:var(--text);outline:none}
.sd-search input:focus{border-color:var(--accent)}
.sd-search button{border:0;border-radius:9px;padding:8px 14px;background:var(--accent);color:var(--on-accent);
  font-size:14px;cursor:pointer;flex:none}
.sd-search button:hover{opacity:.9}
/* 站点简介：纯文字块，**不带任何底色/圆角/边框**。
   ⚠️ 原名 .sd-me，与上面「博主」徽章那条同名 —— 两条规则都会命中同一个元素，
   于是名字块被套上 admin-soft 的淡紫底 + 999px 全圆角（看着就是个紫椭圆），
   字还被染成 admin-text 的紫。2026-09-29 拆成 .sd-about。
   ★ 教训：SIDEBAR_CSS 里一个类名只能有一个用途，新增前先 grep 一遍。 */
.sd-about{display:grid;gap:2px;margin-bottom:8px}
.sd-about b{font-size:15px;color:var(--text)}
.sd-about span{font-size:13px;color:var(--muted)}
.sd-about small{font-size:12.5px;color:var(--muted)}
/* 自定义内容（Markdown 渲染结果）：不能把正文那套大字号带进窄栏，这里单独一套紧凑排版 */
.sd-body{font-size:14px;line-height:1.8;color:var(--text-soft);word-break:break-word}
.sd-body p{margin:0 0 .7em}
.sd-body p:last-child{margin-bottom:0}
.sd-body a{text-decoration:underline;text-underline-offset:2px}
.sd-body ul,.sd-body ol{margin:0 0 .7em;padding-left:1.4em}
.sd-body li{margin:.2em 0}
.sd-body img{max-width:100%;border-radius:8px;border:1px solid var(--line)}
.sd-body code{font-family:var(--font-code);background:var(--inline-code-bg);border-radius:5px;padding:1px 5px;font-size:.9em}
.sd-body pre{margin:.6em 0;background:var(--code-bg);color:var(--code-text);border-radius:10px;overflow:auto}
.sd-body pre code{background:none;color:inherit;padding:0;font-size:13px}
/* 高亮代码块：底色与配色由后台所选主题 CSS 的 pre code.hljs 提供（与正文同规矩，
   pre 上的深色只是「没高亮」时的兜底）。
   ⚠️ 必须写足 .sd-body … code.hljs 四段：主题那条是 (0,1,2)，
   与上面 .sd-body pre code (0,1,2) **特异性相同**，而主题 CSS 注入在本文件之后 ——
   它会赢。少了这一条，code 保持 inline 且无内边距：深色 pre 外壳裸露，
   中间只有一条贴着文字的浅色带。 */
.sd-body pre code.hljs{display:block;padding:10px 12px;font-size:12.5px;line-height:1.6}
.sd-body blockquote{margin:.6em 0;padding:6px 12px;border-left:3px solid var(--accent);background:var(--quote-bg);
  border-radius:0 8px 8px 0;color:var(--quote-text)}
.sd-body blockquote p{margin:.3em 0}
.sd-body hr{border:none;border-top:1px dashed var(--line);margin:.8em 0}
.sd-body h1,.sd-body h2,.sd-body h3,.sd-body h4{font-size:14.5px;margin:.8em 0 .4em}
/* 表格与任务列表：正文（.art-body）有、窄栏这边原先漏了 ——
   自定义栏目里粘一张表格会完全没边框、也没法横向滚动。 */
.sd-body table{border-collapse:collapse;width:100%;margin:.7em 0;font-size:13px;display:block;overflow-x:auto}
.sd-body th,.sd-body td{border:1px solid var(--line);padding:5px 8px;text-align:left}
.sd-body th{background:var(--tint)}
.sd-body li.task{list-style:none;margin-left:-1.2em}
.sd-body li.task input{margin-right:7px;vertical-align:-2px}
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
.brand-mark{width:34px;height:34px;border-radius:9px;background:#2563eb;color:#fff;display:inline-flex;align-items:center;justify-content:center;font-weight:800}
.brand-img{height:36px;width:auto;max-width:170px;object-fit:contain;display:block}
.brand small{display:block;font-weight:400;font-size:12px;color:var(--muted);line-height:1.2}
.nav{display:flex;gap:4px;flex-wrap:wrap;align-items:center}
.nav a{padding:6px 12px;border-radius:8px;color:var(--text);font-size:15px}
.nav a:hover{background:var(--accent-soft);text-decoration:none}
.nav a.on{background:var(--accent);color:var(--on-accent)}
/* 分类下拉：顶级分类带二级时，鼠标移上去（或触屏点一下）自动展开 */
.nav-drop{position:relative;display:inline-block}
.nav-drop>.caret{font-style:normal;font-size:11px;color:var(--muted);margin-left:3px}
.nav-drop.on>.caret,.nav-drop:hover>.caret{color:inherit}
.nav-sub{display:none;position:absolute;left:0;top:100%;z-index:30;min-width:150px;padding:6px;
  background:var(--card);border:1px solid var(--line);border-radius:10px;box-shadow:0 8px 24px rgba(15,23,42,.12)}
.nav-sub a{display:block;padding:6px 12px;white-space:nowrap;font-size:14.5px;border-radius:7px}
.nav-sub a::before{content:"└ ";color:var(--muted)}   /* 二级分类前加拐角，和一级区分 */
.nav-drop:hover>.nav-sub,.nav-drop:focus-within>.nav-sub{display:block}
/* 页头操作区：主题 / 搜索两个图标按钮。单独成块而不挂在 .nav 里，
   是为了让窄屏能把它们挪去跟品牌同行、把整行让给导航条（见下面 640px 段）。 */
.hd-acts{display:flex;align-items:center;gap:6px;flex:none}
/* 导航搜索：平时只有一个放大镜图标，点它就在原地展开输入框（逻辑在 /js/site.js）。
   窄屏放不下，整行落到导航条下方 —— 见 640px 段里的 .hd-acts:has(...) 那条。 */
.hd-search{display:none;align-items:center;gap:6px;margin-left:2px}
.hd-search.open{display:inline-flex}
.hd-search input{width:168px;padding:7px 12px;border:1px solid var(--line);border-radius:9px;
  font-size:14px;background:var(--bg);color:var(--text);outline:none}
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
/* 二级分类：缩进 + 前置拐角标记，和顶级分类区分开 */
.chip-sub{margin-left:6px;background:transparent;border-style:dashed;font-size:12px;padding:3px 12px}
.chip-sub .sub-mark,.cat-card-sub .sub-mark{font-style:normal;color:var(--muted);margin-right:4px}
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
/* 点赞（Ver 0.4 ⑦）：切换语义，已赞时整颗按钮变主色 */
.like-bar{display:flex;align-items:center;justify-content:center;gap:12px;margin:26px 0 2px;flex-wrap:wrap;text-align:center}
.like-btn{display:inline-flex;align-items:center;gap:7px;padding:7px 18px;border:1px solid var(--line);
  border-radius:999px;background:var(--card);color:var(--text-soft);font:inherit;font-size:15px;cursor:pointer}
.like-btn:hover{border-color:var(--accent);color:var(--accent)}
.like-ico{font-size:17px;line-height:1;color:var(--muted)}
.like-btn.on{border-color:var(--accent);background:var(--accent-soft);color:var(--accent)}
.like-btn.on .like-ico{color:var(--accent)}
.like-btn[disabled]{opacity:.55;cursor:default}
.like-tip{font-size:13px;color:var(--muted)}
.like-count-mini{color:var(--muted)}
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
/* 加密文章：列表里的锁标记与提示 */
.lock-mark{font-size:15px;margin-right:4px}
.lock-note{color:var(--muted)!important;font-style:normal}
/* 置顶角标（Ver 0.4 ⑪）：跟着主题色走，实心底 + 反白字，和浅底的标签有区分 */
.pin-badge{display:inline-block;background:var(--accent);color:var(--on-accent);font-size:12.5px;
  font-weight:600;letter-spacing:.5px;padding:1px 8px;border-radius:6px;margin-right:8px;
  vertical-align:2px;white-space:nowrap}
/* 密码页 */
.lock-box{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:34px 30px;text-align:center;margin-top:6px}
.lock-ico{font-size:36px;line-height:1;margin-bottom:10px}
.lock-tip{color:var(--text-soft);font-size:15px;margin:0 0 18px}
.lock-form{display:flex;gap:10px;justify-content:center;flex-wrap:wrap}
.lock-inp{border:1px solid var(--line);background:var(--bg);color:var(--text);border-radius:10px;
  padding:10px 14px;font-size:15px;width:min(260px,70vw);outline:none}
.lock-inp:focus{border-color:var(--accent)}
.lock-inp.bad{border-color:var(--danger,#dc2626)}
.lock-btn{background:var(--accent);color:var(--on-accent);border:0;border-radius:10px;padding:10px 22px;
  font-size:15px;cursor:pointer}
.lock-err{color:var(--danger,#dc2626);font-size:13.5px;margin:14px 0 0}
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
/* 归档（Ver 0.4 ⑭）：顶部规模统计 → 分类/热门标签分布 → 可按年、按月折叠的时间线。
   折叠用原生 <details>，脚本没跑也能点开；展开与否靠 [open] 属性，箭头纯 CSS 旋转。 */
.arc-hero h1{display:flex;align-items:center;gap:10px}
.arc-hero h1 svg{width:26px;height:26px;flex:none;color:var(--accent)}
.arc-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:10px;margin:0 0 16px}
.arc-stat{display:flex;flex-direction:column;gap:3px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px}
.arc-stat b{font-size:24px;line-height:1.15;color:var(--accent);font-variant-numeric:tabular-nums}
.arc-stat span{font-size:12.5px;color:var(--muted)}
.arc-block{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px 22px;margin:0 0 16px}
.arc-h2{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 12px;font-size:14.5px;font-weight:600;color:var(--text-soft)}
.arc-more{font-size:13px;font-weight:400;color:var(--muted)}
.arc-more:hover{color:var(--accent);text-decoration:none}
.arc-block .chips{margin:0}
.arc-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:0 0 10px}
.arc-tabs{display:inline-flex;background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:3px}
.arc-tabs a{padding:5px 16px;border-radius:8px;font-size:13.5px;color:var(--text-soft)}
.arc-tabs a:hover{color:var(--text);text-decoration:none}
.arc-tabs a.on{background:var(--accent);color:var(--on-accent)}
.arc-sum{font-size:13px;color:var(--muted)}
.arc-g{border-top:1px solid var(--line)}
.arc-g:first-child{border-top:0}
.arc-gh{display:flex;align-items:center;gap:10px;padding:12px 2px;cursor:pointer;list-style:none}
.arc-gh::-webkit-details-marker{display:none}
.arc-gh:hover .arc-gt{color:var(--accent)}
.arc-chev{width:8px;height:8px;flex:none;border-right:2px solid var(--muted);border-bottom:2px solid var(--muted);transform:rotate(-45deg);transition:transform .18s}
.arc-g[open] .arc-chev{transform:rotate(45deg)}
.arc-gt{font-size:16px;font-weight:600}
.arc-gc{margin-left:auto;font-size:13px;color:var(--muted)}
.arc-gb{padding:0 0 12px 18px}
.arc-i{display:flex;align-items:baseline;gap:12px;padding:5px 0}
.arc-d{flex:none;width:50px;font-size:13px;color:var(--muted);font-variant-numeric:tabular-nums}
.arc-link{color:var(--text);font-size:15px}
.arc-link:hover{color:var(--accent)}
@media(max-width:640px){.arc-block{padding:16px 14px}.arc-gb{padding-left:8px}}
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
/* 二级分类卡片：缩进一级、虚线边框，和顶级分类区分（必须放在 .cat-card 之后才生效） */
.cat-card-sub{margin-left:16px;border-style:dashed;background:transparent}
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
/* 友圈（Ver 0.4 ⑫）：别人的文章，给标题 + 来源 + 摘要，点标题跳到对方站点 */
.fr-item{display:flex;gap:13px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:15px 17px;margin-bottom:12px}
.fr-item:hover{border-color:var(--accent)}
.fr-ava{width:38px;height:38px;flex:none;border-radius:10px;background:var(--accent-soft);color:var(--accent);display:inline-flex;align-items:center;justify-content:center;font-weight:800;overflow:hidden}
.fr-ava img{width:100%;height:100%;object-fit:cover}
.fr-body{flex:1;min-width:0}
.fr-title{display:block;font-size:16.5px;font-weight:600;color:var(--text);line-height:1.5}
.fr-title:hover{color:var(--accent);text-decoration:none}
.fr-meta{display:flex;align-items:center;flex-wrap:wrap;gap:5px;color:var(--muted);font-size:12.5px;margin-top:5px}
.fr-meta a{color:var(--accent)}
.fr-sum{margin:7px 0 0;color:var(--muted);font-size:13.5px;line-height:1.7}
.empty{background:var(--card);border:1px dashed var(--line);border-radius:12px;padding:34px;text-align:center;color:var(--muted);margin-top:18px}
/* 页脚 */
.ft{border-top:1px solid var(--line);background:var(--card);color:var(--muted);font-size:13.5px;padding:20px 0;text-align:center}
.ft a{color:var(--muted)}
.ft a:hover{text-decoration:underline}
@media (max-width:640px){
 .pc{grid-template-columns:1fr}.pc-cover img{width:100%;height:auto;max-height:180px}
 .article{padding:22px 18px}.comments{padding:20px 18px}.cmt-child{margin-left:20px}
 /* ---- 页头：桌面的 14px 内边距 + 18px 间距在手机上太奢侈，整块占到 175px（近五分之一屏）---- */
 .hd-in{gap:8px 12px;padding:11px 0 0}
 .brand{font-size:18px;gap:8px}
 .brand-mark{width:30px;height:30px;border-radius:8px;font-size:15px}
 .brand-img{height:30px}
 .brand small{font-size:11.5px}
 /* 导航条：独占一行 + 横向滑动，**不换行**。项数是用户在后台随时增减的，
    换行会让页头高度不可控（原来 6 项就撑成两行，第三行只剩两个孤零零的按钮）。
    负边距让它贴到屏幕两侧，滑动时首尾不会被 .wrap 的 20px 内边距截住。 */
 .nav{order:3;width:100%;margin:0 -20px;padding:8px 20px;gap:2px;
   flex-wrap:nowrap;overflow-x:auto;overflow-y:hidden;
   border-top:1px solid var(--line);-webkit-overflow-scrolling:touch;
   scrollbar-width:none;-ms-overflow-style:none;
   /* 右侧渐隐：暗示「这条还能往右滑」。遮罩铺在元素盒子上、不随内容滚动，
     也不用写死背景色，夜间模式自动跟着变。 */
   -webkit-mask-image:linear-gradient(90deg,#000 0,#000 calc(100% - 26px),transparent 100%);
   mask-image:linear-gradient(90deg,#000 0,#000 calc(100% - 26px),transparent 100%)}
 .nav::-webkit-scrollbar{display:none}
 .nav a{padding:9px 13px;font-size:15px;white-space:nowrap;flex:none}
 .nav a.on{font-weight:600}
 /* 下拉在手机上不再做浮层：滑条是 overflow:auto，绝对定位的子菜单会被裁掉
    （overflow 非 visible 的必然结果，绕不过去），改成顺着滑条排开。
    ⚠️ .caret 是 <a> 的子元素（不是 .nav-drop 的），选择器别写成 .nav-drop>.caret。
    ⚠️ 子菜单那条的类名要凑满三个与 .nav-drop:hover>.nav-sub 打平，靠书写顺序取胜。 */
 .nav-drop{position:static;display:flex;align-items:center;gap:2px;flex:none}
 .nav-drop .caret{display:none}
 .nav-drop>a.dup{display:none}   /* 「朋友」与其子项「友链」同页，留一个就够 */
 .nav .nav-drop>.nav-sub{display:flex;position:static;min-width:0;padding:0;gap:2px;
   border:0;background:none;box-shadow:none}
 .nav-sub a{padding:9px 13px;font-size:15px}
 .nav-sub a::before{content:""}   /* 已经平铺成一级项，去掉「└」拐角 */
 /* 主题 / 搜索图标跟品牌同行靠右；搜索框一展开，整个操作区落到导航条下面占满一行 */
 .hd-acts{order:2;margin-left:auto}
 .hd-acts:has(.hd-search.open){order:4;flex:1 1 100%;margin:5px 0 0}
 .hd-search.open{display:flex;flex:1;width:auto}
 .hd-search input{flex:1;width:auto;min-width:0}
}
`;

// 品牌蓝：默认图标（页头首字方块 + 动态 favicon）的固定底色。
// 只认用户上传的 logo_image / favicon_image，主题色改了它不动。
export const BRAND_BLUE = '#2563eb';
// 图标字符：站点标题首字，取不到时回退品牌字「云」，保证各页面（含 404）永远一致。
export function brandChar(s) {
  return (String(s.get('site_title') || '').trim()[0] || '云');
}
// 页头标识：设了 logo_image 用图片，否则用文字方块（按钮式方形 + 首字）
function brandMark(s) {
  const img = String(s.get('logo_image') || '').trim();
  return img ? `<img class="brand-img" src="${esc(img)}" alt="">` : `<span class="brand-mark">${esc(brandChar(s))}</span>`;
}
// 动态图标的版本号：每次改 faviconSvg 的画法（换底色、换形状）都要 +1。
// 它进 URL，URL 一变浏览器与 CDN 就都不会再拿旧缓存 —— 否则改了颜色，浏览器标签里
// 那张旧图能赖上几小时（浏览器对 favicon 有独立缓存，Ctrl+F5 都刷不掉）。
export const FAVICON_VER = '2';
// 自定义图标地址：favicon 优先用 favicon_image，没设则复用 logo_image，都没设则用动态 /favicon.svg
export function faviconHref(s) {
  const custom = String(s.get('favicon_image') || s.get('logo_image') || '').trim();
  if (custom) return custom; // 用户自己的图片：原样用，不加参数
  // 默认动态图标：把版本号与首字拼进 URL，改画法或改站名都能立刻甩掉旧缓存
  return `/favicon.svg?v=${FAVICON_VER}-${encodeURIComponent(brandChar(s))}`;
}
export function faviconMime(href) {
  return /\.svg(\?|$)/i.test(href) ? 'image/svg+xml'
    : /\.png(\?|$)/i.test(href) ? 'image/png'
    : /\.jpe?g(\?|$)/i.test(href) ? 'image/jpeg'
    : /\.webp(\?|$)/i.test(href) ? 'image/webp'
    : /\.ico(\?|$)/i.test(href) ? 'image/x-icon' : '';
}
// 动态 favicon：与页头 .brand-mark 同源（同字、同底色）。
// 底色固定品牌蓝，不跟主题色走 —— 换了主题色标签图标不会跟着变色，只有用户上传自定义图标才变。
export function faviconSvg(s) {
  const ch = esc(brandChar(s));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<rect width="64" height="64" rx="14" fill="${BRAND_BLUE}"/>
<text x="32" y="33" text-anchor="middle" dominant-baseline="central" font-size="38" font-weight="700"
 fill="#fff" font-family="system-ui,-apple-system,'Segoe UI','Microsoft YaHei',sans-serif">${ch}</text>
</svg>`;
}

// 夜间模式切换按钮里的两个图标：白天露太阳、夜里露月亮（CSS 按 data-theme 二选一显示）
const SUN_SVG = `<svg class="ico-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
  stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/>
  <path d="M12 2.6v2.2M12 19.2v2.2M4.2 12H2M22 12h-2.2M5.6 5.6 4 4M20 20l-1.6-1.6M18.4 5.6 20 4M4 20l1.6-1.6"/></svg>`;
const MOON_SVG = `<svg class="ico-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.5 14.3A8.5 8.5 0 1 1 9.7 3.5a6.8 6.8 0 0 0 10.8 10.8Z"/></svg>`;
// 导航搜索图标：点它才在顶栏下方展开输入框（用 <a href="/search"> 以便无 JS 时仍能进搜索页）
const SEARCH_SVG = `<svg class="ico-search" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
  stroke-linecap="round" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.3"/><path d="M15.5 15.5 21 21"/></svg>`;
// 展开后把放大镜换成「×」，提示再点一下是收起
const CLOSE_SVG = `<svg class="ico-close" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
  stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>`;

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
  // 导航栏固定项：首页常驻，其余在「基本设置 → 导航栏显示」里开关（老站没设过就是全显示）
  const navOn = (k) => s.get(k) !== '0';
  // 「朋友」是一个下拉（Ver 0.4 ⑫）：装「友链」与「友圈」两块，鼠标移上去展开。
  // 父项自己也能点（去友链），触屏点一下同样能展开（.nav-drop 的 :focus-within 兜底）。
  const onFriends = o.active === 'links' || o.active === 'friends';
  // 「朋友」本项的 href 与下拉里的「友链」是同一个页面，窄屏把下拉平铺成一行后
  // 会出现两个长得一样的入口 —— 给它挂个 dup，由 CSS 在窄屏隐掉父项、只留子项。
  // （分类下拉的父子 URL 不同，没有这个问题，所以不做通用处理。）
  const navFriends = navOn('nav_show_links')
    ? `<span class="nav-drop"><a class="dup${onFriends ? ' on' : ''}" href="/links">朋友<i class="caret">▾</i></a><span class="nav-sub"><a href="/links"${o.active === 'links' ? ' class="on"' : ''}>友链</a><a href="/friends"${o.active === 'friends' ? ' class="on"' : ''}>友圈</a></span></span>`
    : '';
  const navBuiltin = [
    navOn('nav_show_categories') ? nav('/categories', '分类', 'cat') : '',
    navOn('nav_show_tags') ? nav('/tags', '标签', 'tags') : '',
    navOn('nav_show_archive') ? nav('/archive', '归档', 'arc') : '',
    navFriends,
  ].join('');
  // 分类进导航：路由层把 in_nav=1 的顶级分类（含二级）塞进 s，每个请求各用各的数据
  let navCats = [];
  try {
    const raw = JSON.parse(s.get('_nav_cats') || '[]');
    if (Array.isArray(raw)) navCats = raw;
  } catch (e) { navCats = []; }
  const navCatsHtml = navCats.map((c) => {
    const link = nav(catUrl(c), c.name, 'c:' + c.slug);
    const kids = (c.children || []).map((k) => nav(catUrl(k), k.name, 'c:' + k.slug)).join('');
    // 有二级分类就包成下拉：鼠标移上去自动展开（触屏点一下也能展开，靠 :focus-within）
    return kids
      ? `<span class="nav-drop"><a href="${esc(catUrl(c))}"${o.active === ('c:' + c.slug) ? ' class="on"' : ''}>${esc(c.name)}<i class="caret">▾</i></a><span class="nav-sub">${kids}</span></span>`
      : link;
  }).join('');
  // 全站灰度：后台「基本设置」开关，默认关（Ver 0.4 ⑨）
  const gray = s.get('gray_mode') === '1';
  // 侧边栏（Ver 0.5 ②）：HTML 由路由层在渲染前算好塞进 s（键名带下划线，不会落库）。
  // 空串＝没开侧边栏，此时 DOM 与旧版完全一致（单栏），连这段 CSS 都不输出。
  const side = String(s.get('_sidebar_html') || '');
  const sideLeft = s.get('sidebar_side') === 'left';
  const mainInner = side
    ? `<div class="ly ${sideLeft ? 'sd-left' : 'sd-right'}">`
      + `<div class="ly-m">${o.content}</div>`
      + `<aside class="sd" aria-label="侧边栏">${side}</aside></div>`
    : o.content;
  return `<!doctype html>
<html lang="zh-CN" data-theme="light"${gray ? ' class="gray"' : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${o.title ? esc(o.title) + ' · ' + esc(title) : esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="icon" href="${esc(faviconHref(s))}"${faviconMime(faviconHref(s)) ? ` type="${faviconMime(faviconHref(s))}"` : ''}>
<link rel="alternate" type="application/rss+xml" title="${esc(title)}" href="/rss.xml">
<style>${THEME_VARS}:root{${accentVars(accent)}}${FRONT_CSS}${DARK_VARS}${GRAY_CSS}${side ? SIDEBAR_CSS : ''}${codeThemeCss(s.get('code_theme'))}</style>
<!-- 夜间模式要在第一帧就定下来，否则刷新时会先闪一下白底再变暗；
     这段必须内联在 head 里，放到 /js/site.js（defer）就来不及了。 -->
<script>(function(){try{var t=localStorage.getItem('blog_theme');
if(t!=='dark'&&t!=='light')t=(window.matchMedia&&window.matchMedia('(prefers-color-scheme:dark)').matches)?'dark':'light';
document.documentElement.setAttribute('data-theme',t);}catch(e){}})();</script>
${themeLink(s)}
<!-- 全站加载：文章页用它上报阅读量，所有页面用它上报 PV（后台是独立静态页，不走这里） -->
<script src="/js/site.js" defer></script>
</head>
<body data-slug="${o.bodySlug || ''}">
<header class="hd"><div class="wrap${side ? ' wide' : ''} hd-in">
  <a class="brand" href="/">${brandMark(s)}
    <span>${esc(title)}<small>${esc(s.get('site_subtitle'))}</small></span></a>
  <nav class="nav">
    ${nav('/', '首页', 'home')}
    ${navCatsHtml}
    ${navBuiltin}
    ${navPagesHtml}
    ${navOn('nav_show_rss') ? nav('/rss.xml', 'RSS', 'rss') : ''}
  </nav>
  <!-- 页头操作区：主题与搜索两个按钮原来挂在 .nav 里，手机上被 flex-wrap 甩到第三行、
       两个方块孤零零落在左边（页头因此高达 175px）。拆出来独立成块后，
       窄屏跟品牌同一行靠右，导航条才能安安静静占满一整行（见 FRONT_CSS 的 640px 段）。 -->
  <div class="hd-acts">
    <button type="button" class="theme-btn" id="theme-toggle" aria-label="切换深色模式" title="切换深色 / 浅色">
      ${SUN_SVG}${MOON_SVG}
    </button>
    <form class="hd-search${o.q ? ' open' : ''}" id="search-bar" action="/search" method="get">
      <input name="q" placeholder="搜索文章…" aria-label="搜索文章" value="${o.q ? esc(o.q) : ''}">
    </form>
    <button type="button" class="search-btn${o.q ? ' on' : ''}" id="search-toggle"
      aria-label="搜索文章" aria-expanded="${o.q ? 'true' : 'false'}" title="搜索">${SEARCH_SVG}${CLOSE_SVG}</button>
  </div>
</div></header>
<noscript><style>.hd-search{display:inline-flex}.search-btn{display:none}</style></noscript>
<main class="main"><div class="wrap${side ? ' wide' : ''}">${mainInner}</div></main>
<footer class="ft"><div class="wrap${side ? ' wide' : ''}">
  ${footer ? footer + '<br>' : ''}© ${year} ${esc(title)} · 由 Cloudflare Pages 驱动
  ${beian ? `<br><a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">${esc(beian)}</a>` : ''}
</div></footer>
</body>
</html>`;
}

// ---------- 通用片段 ----------
function catChips(list, base = '/category') {
  if (!list.length) return '';
  // base 分两种：分类用 /category（二级分类拼成 父/子），标签用 /tag（只有一级）
  return `<div class="chips">${list.map((c) => `<a class="chip${c.parent_id ? ' chip-sub' : ''}" href="${base}/${esc(c.full_slug || c.slug)}">${c.parent_id ? '<i class="sub-mark">└</i>' : ''}${esc(c.name)}<b> ${c.count || 0}</b></a>`).join('')}</div>`;
}
// 置顶角标（Ver 0.4 ⑪）：首页卡片走 postCard，但分类 / 标签 / 搜索页各自手写了卡片模板，
// 统一由这里产出，免得以后改样式漏掉某处。
export const pinBadge = (p) => (p && p.pinned ? '<span class="pin-badge">置顶</span>' : '');

// p 之后可传设置 Map s；传了就用「永久链接」规则生成地址，否则退回 /post/:slug
function postCard(p, s) {
  const url = esc(s ? postUrl(s, p) : '/post/' + p.slug);
  // 加密文章：摘要不能外泄（列表、RSS 都只看得到标题）
  const locked = !!p.locked;
  const excerpt = locked ? '' : (p.excerpt || stripHtml(p.content_html).slice(0, 260));
  const tags = locked ? '' : (p.tags || []).map((t) => `<a class="tag-chip" href="/tag/${esc(t.slug)}">${esc(t.name)}</a>`).join('');
  // 加密文章：分类仍可显示（不泄露正文），标签与封面不外露
  const cat = p.category ? `<a href="${esc(catUrl(p.category))}">${esc(p.category.name)}</a>` : '';
  // 封面同样不外露：图里常常就有正文内容
  const cover = (!locked && p.cover_key)
    ? `<div class="pc-cover"><a href="${url}"><img src="/media/${esc(p.cover_key)}" alt="" loading="lazy"></a></div>` : '';
  return `<article class="pc${cover ? '' : ' no-cover'}"><div>
    <div class="pc-meta">
      <time>${fmtDate(p.published_at || p.created_at)}</time>
      ${cat ? `<span class="dot">·</span>${cat}` : ''}
      <span class="dot">·</span><span>阅读 ${p.view_count || 0}</span>
      <span class="dot">·</span><span>${p.comment_count || 0} 评论</span>
      ${p.likes ? `<span class="dot">·</span><span class="like-count-mini">♥ ${p.likes}</span>` : ''}
    </div>
    <h2 class="pc-title">${pinBadge(p)}${locked ? '<span class="lock-mark">🔒</span>' : ''}<a href="${url}">${esc(p.title)}</a></h2>
    ${locked ? '<p class="pc-excerpt lock-note">本文已加密，需输入密码访问</p>'
      : (excerpt ? `<p class="pc-excerpt">${esc(excerpt)}</p>` : '')}
    ${tags ? `<div class="pc-tags">${tags}</div>` : ''}
  </div>${cover}</article>`;
}
// 唯一的分页条实现（首页 / 分类 / 标签 / 友圈共用），别再各写一份 —— 复制出去的版本迟早会
// 跟这里长得不一样，前面那个 bug 就是这么来的。
// makeUrl 决定「第 n 页」的地址：优先传函数（分类 / 标签 / 友圈这类地址不规则的页面必须传），
// 也可以只给一个前缀字符串（首页传 '/'）。第 1 页一律回退到列表第一页，不产出 /page/1 这种重复地址。
// Ver 0.4 修复：此前这里只认 base 字符串，调用方辛辛苦苦算好的 makeUrl 被整个忽略，
// 于是分类页、标签页从第 2 页起链接变成 "undefinedpage/1"，点了原地踏步。
export function pagination(page, pages, makeUrl) {
  // pages 不是有效数字（例如搜索页只有一页、调用方压根没传 pages）就整块不渲染，
  // 否则会冒出一个只有两个灰按钮、什么都点不了的空白分页条。
  if (!Number.isFinite(pages) || pages <= 1) return '';
  const href = typeof makeUrl === 'function'
    ? makeUrl
    : (n) => {
      const base = String(makeUrl || '/').replace(/\/+$/, '');
      return n <= 1 ? (base || '/') : `${base}/page/${n}`;
    };
  // 手改地址栏翻到越界页（page/99）时把当前页夹回范围内，免得数字区一片空白
  const cur = Number.isFinite(page) ? Math.min(Math.max(1, Math.floor(page)), pages) : 1;
  let nums = '';
  for (let n = Math.max(1, cur - 2); n <= Math.min(pages, cur + 2); n++) {
    nums += n === cur ? `<span class="cur">${n}</span>` : `<a href="${href(n)}">${n}</a>`;
  }
  const prev = cur > 1 ? `<a href="${href(cur - 1)}">‹ 上一页</a>` : '<span class="dim">‹ 上一页</span>';
  const next = cur < pages ? `<a href="${href(cur + 1)}">下一页 ›</a>` : '<span class="dim">下一页 ›</span>';
  return `<nav class="pager">${prev}${nums}${next}</nav>`;
}

// ---------- 各页面 ----------
export function renderHome(s, data, page) {
  // ⚠️ 必须写成箭头函数：map 会把下标当第二个参数传进来，直接传 postCard 会把 s 顶掉
  const items = data.items.map((p) => postCard(p, s)).join('');
  // 首页第 1 页就是 /，不做成 /page/1（两条地址同内容，搜索引擎算重复页）
  const homeUrl = (n) => (n <= 1 ? '/' : `/page/${n}`);
  const content = `
    <section class="hero"><h1>最新文章</h1></section>
    ${catChips(data.categories)}
    ${items ? `<div class="plist">${items}</div>` + pagination(page, data.pages, homeUrl)
      : `<div class="empty">还没有发布文章</div>`}`;
  return layout(s, { content, active: 'home', bodySlug: '' });
}

export function renderListPage(s, o) {
  // o: {head, desc, itemsHtml, page, pages, makeUrl}
  // makeUrl(n) 由调用方给：分类 / 标签的地址规则各不相同，分页条不能自己猜
  return layout(s, {
    active: o.active, q: o.q, title: o.title,
    content: `<section class="page-head"><h1>${o.head}</h1>${o.desc ? `<p class="desc">${o.desc}</p>` : ''}${o.extra || ''}</section>
    ${o.itemsHtml ? `<div class="plist">${o.itemsHtml}</div>` : (o.extra ? '' : `<div class="empty">${o.empty || '暂无内容'}</div>`)}
    ${pagination(o.page, o.pages, o.makeUrl)}`,
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

// 面包屑里的分类段：二级分类显示成「父 / 子」两级，各自可点
function crumbCat(c) {
  if (!c) return '';
  const parent = c.parent_slug
    ? `<a href="/category/${esc(c.parent_slug)}">${esc(c.parent_name || c.parent_slug)}</a> / ` : '';
  return `${parent}<a href="${esc(catUrl(c))}">${esc(c.name)}</a> / `;
}

// ---------- 点赞（Ver 0.4 ⑦） ----------
// 只带文章 id：点赞是「切换」语义，同一访客再点一次就是取消，所以按钮不需要知道当前状态以外的东西。
// 加密文章与独立页面不渲染（前者连正文都看不到，后者没有文章的互动属性）。
export function likeBar(post) {
  if (!post || post.type === 'page' || post.locked) return '';
  const n = post.likes || 0;
  return `<div class="like-bar">
    <button type="button" class="like-btn${post.liked ? ' on' : ''}" data-like="${post.id}"
      aria-label="点赞" aria-pressed="${post.liked ? 'true' : 'false'}">
      <span class="like-ico">♥</span><span class="like-n">${n}</span>
    </button>
    <span class="like-tip">${post.liked ? '已赞，再点一次取消' : '觉得有用就点个赞'}</span>
  </div>`;
}

export function renderArticle(s, post, extra) {
  const cover = post.cover_key
    ? `<div class="art-cover"><img src="/media/${esc(post.cover_key)}" alt="${esc(post.title)}"></div>` : '';
  const tags = (post.tags || []).map((t) => `<a class="tag-chip" href="/tag/${esc(t.slug)}">${esc(t.name)}</a>`).join('');
  const meta = [
    `<span>${esc(s.get('author_name'))}</span>`,
    `<time>${fmtDate(post.published_at, true)}</time>`,
    post.category ? `<a href="${esc(catUrl(post.category))}">${esc(post.category.name)}</a>` : '',
    `<span>${post.view_count || 0} 次阅读</span>`,
  ].filter(Boolean).join('<span class="dot">·</span>');
  const pn = extra.siblings;
  const pnHtml = `<nav class="pn">
    ${pn.prev ? `<a href="${esc(postUrl(s, pn.prev))}"><small>← 上一篇</small>${esc(pn.prev.title)}</a>` : '<span></span>'}
    ${pn.next ? `<a class="next" href="${esc(postUrl(s, pn.next))}"><small>下一篇 →</small>${esc(pn.next.title)}</a>` : '<span></span>'}
  </nav>`;
  const content = `
    <p class="crumb"><a href="/">首页</a> / ${crumbCat(post.category)}正文</p>
    <article class="article">
      <h1>${pinBadge(post)}${esc(post.title)}</h1>
      <div class="art-meta">${meta}</div>
      ${cover}
      <div class="art-body">${post.content_html}</div>
      ${likeBar(post)}
      ${tags ? `<div class="pc-tags" style="margin-top:18px">${tags}</div>` : ''}
      ${copyrightHtml(s, post, extra.origin)}
    </article>
    ${pnHtml}
    ${renderComments(s, post, extra.comments, extra.cfg)}`;
  return layout(s, { content, title: post.title, active: 'home', bodySlug: post.slug });
}

// ---------- 加密文章的密码页（Ver 0.4 ④） ----------
// 只给标题 + 密码框：正文、标签、评论、上下篇、版权一律不输出，
// bodySlug 留空，前端也就不会上报阅读量。
export function renderLocked(s, post, wrong) {
  const url = postUrl(s, post);
  const content = `
    <p class="crumb"><a href="/">首页</a> / 正文</p>
    <article class="article">
      <h1>${esc(post.title)}</h1>
      <div class="lock-box">
        <div class="lock-ico">🔒</div>
        <p class="lock-tip">本文已加密，请输入访问密码</p>
        <form class="lock-form" method="post" action="${esc(url)}">
          <input class="lock-inp${wrong ? ' bad' : ''}" type="password" name="post_password"
            placeholder="访问密码" autocomplete="current-password" autofocus>
          <button class="lock-btn" type="submit">解锁阅读</button>
        </form>
        ${wrong ? '<p class="lock-err">密码不正确，请重试</p>' : ''}
      </div>
    </article>`;
  return layout(s, { content, title: post.title, active: 'home', bodySlug: '', desc: '' });
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

// ---------- 归档（Ver 0.4 ⑭） ----------
// 结构：站点规模统计 → 分类与热门标签分布 → 时间线。
// 时间线分「按年份 / 按月份」两种（?view=month 切换，服务端渲染，不依赖脚本）；
// 折叠用原生 <details>，脚本没跑也能点开；默认只展开最新的一组。
const ARC_ICO = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 4.5h7.2L18 8.3V19H7a1.5 1.5 0 0 1-1.5-1.5V6A1.5 1.5 0 0 1 7 4.5Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M14 4.5V8h4M8.5 11h6M8.5 14h6M8.5 17h3.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// 分组键：年份视图取 yyyy，月份视图取 yyyy-mm；没发布时间的归一组放最后（正常不会有）
function arcGroups(posts, view) {
  const g = new Map();
  for (const p of posts || []) {
    const d = String(p.published_at || '');
    const key = d.slice(0, view === 'month' ? 7 : 4) || '0';
    if (!g.has(key)) g.set(key, []);
    g.get(key).push(p);
  }
  // 新的在前；'0'（无日期）字典序最小，这样排完自然落到最后
  return [...g.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
}

function arcGroupTitle(key, view) {
  if (key === '0') return '未标注日期';
  if (view === 'month') return `${key.slice(0, 4)} 年 ${parseInt(key.slice(5, 7), 10)} 月`;
  return `${key} 年`;
}

function arcItem(s, p, view) {
  const d = String(p.published_at || '');
  const day = d.slice(0, 10);
  // 年份视图的分组只有年，条目得带上月；月份视图分组已是当月，条目只留「日」
  const label = (view === 'month' ? d.slice(8, 10) : d.slice(5, 10)) || day || '—';
  return `<article class="arc-i"><time class="arc-d"${day ? ` datetime="${esc(day)}"` : ''}>${esc(label)}</time>`
    + `<a class="arc-link" href="${esc(postUrl(s, p))}">${esc(p.title)}</a></article>`;
}

// 记住各分组的展开状态。纯增强：脚本没跑就回到「只展开最新一组」的默认样子，不影响阅读。
// 分组数量变了（发了新文章、跨了新年份）就丢弃记忆，避免状态错位。
const ARC_KEEP = '<script>(function(){try{'
  + "var g=document.querySelectorAll('details.arc-g');if(g.length<2)return;var k='arc-open';var v=null;"
  + "try{v=JSON.parse(localStorage.getItem(k)||'null')}catch(e){v=null}"
  + 'if(v&&v.length===g.length){for(var i=0;i<g.length;i++)g[i].open=!!v[i]}'
  + 'var save=function(){var a=[];for(var j=0;j<g.length;j++)a.push(g[j].open);'
  + "try{localStorage.setItem(k,JSON.stringify(a))}catch(e){}};"
  + "for(var n=0;n<g.length;n++)g[n].addEventListener('toggle',save)}catch(e){}})();</script>";

export function renderArchive(s, { posts = [], stats = {}, cats = [], tags = [], view = 'year' } = {}) {
  const list = (posts || []).filter(Boolean);
  const siteTitle = String(s.get('site_title') || '').trim() || '本站';
  const sub = String(s.get('site_subtitle') || '').trim();
  if (!list.length) {
    return layout(s, {
      title: '归档', active: 'arc',
      content: `<section class="page-head arc-hero"><h1>${ARC_ICO}文章归档</h1></section>`
        + '<div class="empty">还没有发布文章</div>',
    });
  }
  const groups = arcGroups(list, view);
  const yearSet = new Set();
  for (const p of list) {
    const y = String(p.published_at || '').slice(0, 4);
    if (y) yearSet.add(y);
  }
  const span = yearSet.size > 1 ? `，横跨 ${yearSet.size} 个年份` : '';
  const desc = sub || `收录了 ${list.length} 篇文章${span}`;

  // 规模统计：友链与友圈订阅没有内容时不出格子，免得新站顶着一排 0
  const st = (n, t) => `<div class="arc-stat"><b>${Number(n) || 0}</b><span>${t}</span></div>`;
  const statHtml = [
    st(stats.posts || list.length, '篇文章'),
    st(stats.cats || 0, '个分类'),
    st(stats.tags || 0, '个标签'),
    st(stats.comments || 0, '条评论'),
    Number(stats.links) > 0 ? st(stats.links, '个友链') : '',
    Number(stats.feeds) > 0 ? st(stats.feeds, '个订阅') : '',
  ].filter(Boolean).join('');

  // 分类按树序排（二级紧跟在自己的父分类后面），和「全部分类」页保持一致 ——
  // listCategories() 是按 parent_id 排的，二级会全部堆到最后，看起来像散落的平级分类
  const catBlock = cats.length
    ? `<section class="arc-block">
      <h2 class="arc-h2">分类统计<a class="arc-more" href="/categories">全部 ${cats.length} 个 →</a></h2>
      ${catChips(db.treeCategories(cats), '/category')}
    </section>` : '';
  // 标签动辄上百个，这里只挑文章最多的 20 个当门面，其余去「全部标签」看
  const topTags = [...tags].sort((a, b) => (b.count || 0) - (a.count || 0)).slice(0, 20);
  const tagBlock = topTags.length
    ? `<section class="arc-block">
      <h2 class="arc-h2">热门标签<a class="arc-more" href="/tags">全部 ${tags.length} 个 →</a></h2>
      ${catChips(topTags, '/tag')}
    </section>` : '';

  const tabs = `<span class="arc-tabs">`
    + `<a href="/archive"${view === 'month' ? '' : ' class="on"'}>按年份</a>`
    + `<a href="/archive?view=month"${view === 'month' ? ' class="on"' : ''}>按月份</a></span>`;
  const items = groups.map(([key, arr], i) => `<details class="arc-g"${i === 0 ? ' open' : ''}>
      <summary class="arc-gh"><span class="arc-chev" aria-hidden="true"></span>`
    + `<span class="arc-gt">${esc(arcGroupTitle(key, view))}</span>`
    + `<span class="arc-gc">${arr.length} 篇</span></summary>
      <div class="arc-gb">${arr.map((p) => arcItem(s, p, view)).join('')}</div>
    </details>`).join('');

  return layout(s, {
    title: '归档', active: 'arc', desc: `${siteTitle} 的文章归档，共 ${list.length} 篇`,
    content: `<section class="page-head arc-hero">
      <h1>${ARC_ICO}文章归档</h1>
      <p class="desc">${esc(siteTitle)} · ${esc(desc)}</p>
    </section>
    <section class="arc-stats">${statHtml}</section>
    ${catBlock}${tagBlock}
    <section class="arc-block">
      <div class="arc-bar">${tabs}<span class="arc-sum">共 ${list.length} 篇 · ${groups.length} ${view === 'month' ? '个月份' : '个年份'}</span></div>
      ${items}
    </section>
    ${ARC_KEEP}`,
  });
}

// ---------- 分类 / 标签总览页 ----------
// 导航栏「分类」「标签」指向 /categories 与 /tags，此前这两个页面根本不存在（点进去是 404，
// 页头还因拿不到设置而退化成兜底字）——现在补齐。
export function renderCategories(s, list) {
  // 按父子重排：二级分类紧跟在自己的上级后面，一眼看出层级
  const tree = db.treeCategories(list);
  const subs = list.filter((c) => c.parent_id).length;
  return layout(s, {
    title: '全部分类', active: 'cat',
    desc: `${String(s.get('site_title') || '').trim()} 的全部分类`,
    content: `<section class="article">
      <h1 style="margin:0 0 6px">全部分类</h1>
      <p style="color:var(--muted);margin:0 0 18px">共 ${list.length} 个分类${subs ? `（含 ${subs} 个二级分类）` : ''}</p>
      ${tree.length ? catChips(tree, '/category') : '<p style="color:var(--muted)">还没有创建分类。</p>'}
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

// ---------- 友圈（Ver 0.4 ⑫） ----------
// 展示订阅到的别人的文章：标题跳原文（外链，加 nofollow），来源跳对方站点。
// 摘要抓取时已清洗成纯文本，这里只做转义，不信任任何 HTML。
function friendCard(p) {
  const name = String(p.feed_name || '').trim() || '未命名站点';
  const ch = (name[0] || '?').toUpperCase();
  const avatar = p.feed_avatar
    ? `<img src="${esc(p.feed_avatar)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
    : esc(ch);
  const site = p.feed_site
    ? `<a href="${esc(p.feed_site)}" target="_blank" rel="noopener noreferrer">${esc(name)}</a>`
    : `<span>${esc(name)}</span>`;
  const time = String(p.published_at || '').slice(0, 16);
  return `<article class="fr-item">
    <span class="fr-ava">${avatar}</span>
    <div class="fr-body">
      <a class="fr-title" href="${esc(p.link)}" target="_blank" rel="noopener noreferrer nofollow">${esc(p.title)}</a>
      <div class="fr-meta">${site}<span class="dot">·</span><time>${esc(time)}</time>${p.author ? `<span class="dot">·</span><span>${esc(p.author)}</span>` : ''}</div>
      ${p.summary ? `<p class="fr-sum">${esc(p.summary)}</p>` : ''}
    </div></article>`;
}
export function renderFriends(s, { posts = [], feeds = [], total = 0, page = 1, pages = 1 } = {}) {
  const desc = feeds.length
    ? `来自 ${feeds.length} 个朋友的站点，共 ${total} 篇文章 · 按发布时间倒序`
    : '订阅朋友们的站点，把他们的新文章汇总到这里';
  const body = posts.length
    ? `<div class="fr-list">${posts.map(friendCard).join('')}</div>`
      + pagination(page, pages, (n) => (n <= 1 ? '/friends' : `/friends/page/${n}`))
    : '<div class="empty">友圈还是空的。站长可在后台「朋友 → 友圈」里添加朋友的 RSS 地址。</div>';
  return layout(s, {
    title: '友圈', active: 'friends',
    desc: `${String(s.get('site_title') || '').trim()} 的朋友们最近写了什么`,
    content: `<section class="page-head"><h1>友圈</h1><p class="desc">${esc(desc)}</p></section>${body}`,
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

// RSS / Sitemap 页面共用骨架（浏览器直接打开时的排版页，给阅读器与爬虫的仍是标准 XML）
function feedLayout({ icon, title, sub, home, bar, body, foot, gray }) {
  return `<!doctype html>
<html lang="zh-CN" data-theme="light"${gray ? ' class="gray"' : ''}><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>${FEED_CSS}${GRAY_CSS}</style>
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
  // 加密文章不进 RSS：订阅是明文分发，收进去等于把密码绕过去
  // 置顶只在站内列表生效：RSS / 站点地图是「订阅与收录」语义，一律保持时间倒序
  const data = await db.listPosts(env.DB, { status: 'published', unlockedOnly: true, per: 50, pinFirst: false });
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
    gray: s.get('gray_mode') === '1',
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
  for (const c of cats) rows.push(u(catUrl(c), '分类', 'c', ''));
  const tags = await db.listTags(env.DB);
  for (const t of tags) rows.push(u('/tag/' + t.slug, '标签', 't', ''));
  const data = await db.listPosts(env.DB, { status: 'published', per: 1000, pinFirst: false });
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
    gray: s.get('gray_mode') === '1',
  });
}

// ---------- XML（给阅读器与搜索引擎的标准数据）----------
export async function rssXml(env, s, origin) {
  // 加密文章不进 RSS：订阅是明文分发，收进去等于把密码绕过去
  const data = await db.listPosts(env.DB, { status: 'published', unlockedOnly: true, per: 50, pinFirst: false });
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
  const rows = [u('/', ''), u('/archive', ''), u('/categories', ''), u('/tags', ''), u('/links', ''), u('/friends', '')];
  const cats = await db.listCategories(env.DB);
  for (const c of cats) rows.push(u(esc(catUrl(c)), ''));
  const tags = await db.listTags(env.DB);
  for (const t of tags) rows.push(u('/tag/' + esc(t.slug), ''));
  const data = await db.listPosts(env.DB, { status: 'published', per: 1000, pinFirst: false });
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
  // 灰度与夜间同样作用于预览：不然后台开了全站灰度，编辑器里看着还是彩色的
  const gray = s.get('gray_mode') === '1';
  return `<!doctype html><html lang="zh-CN" data-theme="light"${gray ? ' class="gray"' : ''}><head><meta charset="utf-8">
<base href="${esc(origin)}/">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>预览</title>
<style>${THEME_VARS}:root{${accentVars(accentOf(s))}}${DARK_VARS}${GRAY_CSS}
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

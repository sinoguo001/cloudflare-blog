// ============================================================
// 自定义文章字体（Ver 0.6 ①）
//
// 两种来源，最终都只是往 <head> 里塞一小段样式：
//   本地上传 —— 字体文件存 R2 的 fonts/ 前缀，由 /fonts/* 下发，这里生成 @font-face；
//   远程链接 —— 用户粘贴的 CSS 链接（Google Fonts / 中文网字计划那类）→ <link>；
//              粘贴 .woff2/.woff/.ttf/.otf 直链 → 也生成 @font-face。
//              按 URL 结尾自动分辨，不用站点主自己选。
//
// 作用范围只有文章正文（.art-body）：页头、导航、侧边栏、页脚一律维持系统默认字体栈，
// 所以除了文章页，其它页面连一个字节的字体流量都不会多花。
//
// ★ 两个坑：
// 1) 输出的样式必须排在主题样式表【之后】。主题同样会写 .art-body{…}
//    （正文是主题最常改的地方），与下面这条规则特异性相同，靠「后出现者赢」；
//    排在主题前面就会被整套压掉，表现是「后台设了字体、前台纹丝不动」。
//    注意「主题写 :root{--font-body:…}」并不会压掉我们 —— :root 只是改了这个变量的值，
//    而变量在我们这条规则里是【兜底】，主字族仍是我们排在前面的那个。
// 2) 字体名与链接都要拼进 CSS，两个都必须先洗。名字里一个 } 就能提前闭合规则、
//    把后面的声明全带跑（CSS 注入）。
// ============================================================
import { esc } from './util.js';

// R2 键前缀。单独一个前缀，不跟 media/ 混 —— 字体不是图片，
// 丢进媒体库只会让「媒体库」里多出一堆打不开的裂图占位卡。
export const FONT_PREFIX = 'fonts/';

// 支持的四类。按落库扩展名给 CSS 的 format() 名 —— 写错浏览器会静默不加载该字体。
export const FONT_EXTS = ['woff2', 'woff', 'ttf', 'otf'];
export const FONT_KINDS = { woff2: 'woff2', woff: 'woff', ttf: 'truetype', otf: 'opentype' };
export const FONT_MIME = { woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf' };

// 浏览器发来的 content-type -> 扩展名。前端还会额外带一个 ?ext=，
// 因为 .ttf/.otf 在不少浏览器上被报成 application/octet-stream，只看 content-type 会误拒。
export const FONT_TYPES = {
  'font/woff2': 'woff2', 'application/font-woff2': 'woff2', 'application/x-font-woff2': 'woff2',
  'font/woff': 'woff', 'application/font-woff': 'woff', 'application/x-font-woff': 'woff',
  'font/ttf': 'ttf', 'application/x-font-ttf': 'ttf', 'application/font-sfnt': 'ttf',
  'font/otf': 'otf', 'application/x-font-otf': 'otf', 'application/vnd.ms-opentype': 'otf',
};

// 中文全字库 woff2 常见 5~10MB，思源宋体一档能到 15MB 上下，20MB 够用。
export const FONT_MAX = 20 * 1024 * 1024;
export const fontLimitMsg = `字体文件不能超过 ${Math.round(FONT_MAX / 1048576)}MB`;

// ---------- 两个清洗函数：落库前与生成 CSS 前都会用 ----------

// 字体族名白名单。只留字母数字、下划线、连字符、点、空格与中日韩汉字 ——
// 名字里的引号、花括号、分号、反斜杠全部剔掉，拼进 CSS 才不会有逃逸风险。
// （汉字范围取 \u3400-\u9fff 而不是常用的 \u4e00-\u9fa5：扩展 A 区有几个字
//   真出现在字体名里；\u3007「〇」也单列，某些老字库名带它。）
export function safeFamily(v) {
  return String(v || '')
    .replace(/[^\w\u3007\u3400-\u9fff\-. ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

// 链接白名单：只认站内相对路径与 http(s)。另外挡掉尖括号 ——
// URL 里的 < > 一律是非法字符，而 </style> 又是唯一能从 <style> 里逃出去的东西。
// 其余字符（& ; " ( ) 等）留给下游各自转义：HTML 属性走 esc()，CSS 里走 cssStr()。
export function safeFontUrl(v) {
  const u = String(v || '').trim();
  if (!/^(https?:\/\/|\/)/i.test(u)) return '';
  if (/[<>]/.test(u)) return '';
  return u.slice(0, 300);
}

// CSS 字符串字面量的转义：反斜杠与双引号要转，换行类字符直接去掉（CSS 里不允许裸换行）。
const cssStr = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\n\r\f]/g, '');

// URL 指向的是字体文件本身（→ 自己生成 @font-face），还是别人的样式表（→ 直接引进来）
export function isFontFile(u) {
  const tail = String(u).split('#')[0].split('?')[0];
  const ext = (tail.split('.').pop() || '').toLowerCase();
  return FONT_EXTS.includes(ext);
}

// 当前真正生效的一套配置。没启用 / 没填 / 填得不合法都返回 null，
// 调用方据此输出空串 —— 于是页面 DOM 与没有这个功能时完全一致。
export function fontPick(s) {
  if (!s || s.get('font_on') !== '1') return null;
  const family = safeFamily(s.get('font_family'));
  if (!family) return null;
  const mode = s.get('font_src') === 'remote' ? 'remote' : 'local';
  const url = safeFontUrl(s.get(mode === 'remote' ? 'font_remote' : 'font_local'));
  if (!url) return null;
  return { mode, url, family };
}

// ---------- 输出：塞进 <head> 的一段 HTML ----------
// 返回 '' ＝ 未启用（或配置不完整），页面上不出现任何额外标签与样式。
export function fontHead(s) {
  const p = fontPick(s);
  if (!p) return '';
  // 只改文章正文。后面的 var(--font-body) 是兜底：字体没加载出来就退回默认栈，
  // 不会出现「字体挂了整页变衬线」的崩坏。
  const rule = `.art-body{font-family:'${p.family}',var(--font-body)}`;

  // 远程样式表（CSS 链接）：@font-face 由对方定义，我们只负责引进来再改字体族。
  if (p.mode === 'remote' && !isFontFile(p.url)) {
    return `<link rel="stylesheet" href="${esc(p.url)}">\n<style>${rule}</style>`;
  }

  const ext = (String(p.url).split('#')[0].split('?')[0].split('.').pop() || '').toLowerCase();
  const fmt = FONT_KINDS[ext] || 'woff2';
  // font-display:swap —— 字体没到位时先用系统字体把字显示出来，
  // 不让一整个中文字体文件（好几 MB）把首屏文字卡成空白。
  return `<style>@font-face{font-family:'${p.family}';src:url("${cssStr(p.url)}") format("${fmt}");font-display:swap}${rule}</style>`;
}

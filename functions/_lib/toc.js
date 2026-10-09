// ============================================================
// 文章目录 / 摘要卡片（Ver 0.5 ⑧）
// ------------------------------------------------------------
// 从「已渲染好的正文 HTML」里抽出章节标题，生成锚点 id 与目录。
//
// 为什么不在 md.js 里渲染时就写死 id：
//   那样只有「保存过的文章」才有锚点，老文章必须挨个重新保存一次才出目录。
//   这里改成每次渲染文章页时现场算一遍 —— 老文章立刻生效，也不用改存储结构。
//
// 为什么按「IP / 文本」而不是按位置编号：
//   标题文字变了（改个错别字）编号就会串，别人收藏的 #锚点 也就失效了。
// ============================================================

import { esc } from './util.js';

// 收录哪几级标题：h2 是大章节、h3 是它下面的小节。
// h1 不收 —— 文章标题已经是 h1，收进来等于把标题重复一遍。
// h4 及以下不收 —— 层级太深，目录会又长又碎。
export const TOC_LEVELS = [2, 3];

// 少于这么多条就不出目录：只有一个章节的文章摆个「目录」卡片反而碍眼，
// 而且那种卡片点了也只是跳到正文开头，没有意义。
export const TOC_MIN = 2;

// 单个锚点最长多少字符：超长标题（比如整句话当小标题）会把 URL 撑得没法看，
// 截断只影响锚点，目录里显示的文字仍是完整的。
const SLUG_MAX = 60;

// 匹配 <h2 ...>标题</h2> / <h3 ...>标题</h3>
// ⚠️ 正则由上面的 TOC_LEVELS 拼出来，改那一行这里就跟着变。
//    曾经把层级写死成 <h([23])，结果 TOC_LEVELS 成了改不动的摆设
//    （反向验证 M5/M6 就是改它却没被任何断言发现）。
// 用 [\s\S] 而不是 .：标题里可能有换行（编辑器粘过来的多行标题）。
// 结尾必须闭合同名标签（\1），避免跨段落误匹配。
const H_RE = new RegExp(`<h([${TOC_LEVELS.join('')}])\\b([^>]*)>([\\s\\S]*?)</h\\1>`, 'gi');

const ENT = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'",
  nbsp: ' ', '#160': ' ', '#32': ' ', ldquo: '“', rdquo: '”', hellip: '…',
};

// 把 &amp; &lt; &#39; 这类实体还原成字符：目录里显示的是「人看的文字」，
// 不还原的话标题带 & 就会显示成 "&amp;"。
function decodeEnt(s) {
  return String(s == null ? '' : s).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, g) => {
    if (g[0] === '#') {
      const neg = g[1] === 'x' || g[1] === 'X';
      const n = parseInt(neg ? g.slice(2) : g.slice(1), neg ? 16 : 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    const k = g.toLowerCase();
    return Object.prototype.hasOwnProperty.call(ENT, k) ? ENT[k] : m;
  });
}

// 把标题文字变成能放进 URL 的锚点。
// 保留任何语言的字母与数字（\p{L}\p{N}），其余一律换成连字符 ——
// 中文标题因此能原样进锚点，不用转拼音。
export function slugify(text) {
  let s = String(text == null ? '' : text)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '');
  // id 以数字开头虽合法，但 CSS 选择器里不好写，统一加个前缀
  if (s && /^[0-9]/.test(s)) s = 's-' + s;
  return s || '';
}

// 同一篇文章里出现两个一样的标题（很常见：好几个「小结」），
// 第二个往后加 -2 / -3，否则锚点互相覆盖、目录点了跳错地方。
function uniqId(base, used) {
  const n = (used.get(base) || 0) + 1;
  used.set(base, n);
  return n === 1 ? base : base + '-' + n;
}

/**
 * 扫描正文 HTML：给每个 h2/h3 补上 id，同时返回目录条目。
 * @param {string} html 已渲染的正文
 * @returns {{ html: string, items: Array<{lv:number,text:string,id:string}> }}
 * 幂等：重复调用不会产生两个 id（已有 id 的标题直接沿用）。
 */
export function buildToc(html) {
  const src = String(html == null ? '' : html);
  const items = [];
  const used = new Map();
  let out = '';
  let last = 0;
  H_RE.lastIndex = 0;
  let m;
  while ((m = H_RE.exec(src)) !== null) {
    const lv = parseInt(m[1], 10);
    const attrs = m[2] || '';
    const inner = m[3] || '';
    // 目录里显示的文字：先剥掉 <code> 之类的行内标签，再还原实体
    const text = decodeEnt(inner.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
    // 空标题（比如写了个 "## " 就换行）不进目录、也不占锚点
    if (!text) continue;
    // ⚠️ 这里的 \b 不能少：写成 /bid.../ 就成了找字母 "bid"，永远匹配不上，
    //    于是已经带 id 的标题会被重新 slug 一遍、旧锚点失效。
    const hasId = /\bid\s*=\s*"[^"]*"/i.test(attrs);
    const oldId = hasId ? ((/\bid\s*=\s*"([^"]*)"/i.exec(attrs) || [])[1] || '') : '';
    const id = hasId && oldId ? oldId : uniqId(slugify(text) || 'sec', used);
    items.push({ lv, text, id });
    out += src.slice(last, m.index)
      + `<h${lv}${attrs}${hasId ? '' : ` id="${esc(id)}"`}>${inner}</h${lv}>`;
    last = m.index + m[0].length;
  }
  out += src.slice(last);
  return { html: out, items };
}

/**
 * 目录卡片的 HTML。条目不够 TOC_MIN 就返回空串（页面 DOM 与没开时完全一致）。
 * @param {Array} items buildToc 的返回值
 * @param {{float?:boolean}} opt float=true 时额外挂 toc-fix 类，
 *        由 CSS 在宽屏把它悬浮到正文右侧；窄屏自动退回正文顶部的普通卡片。
 */
export function tocHtml(items, opt = {}) {
  const list = (Array.isArray(items) ? items : []).filter((x) => x && x.id);
  if (list.length < TOC_MIN) return '';
  const lis = list.map((x) => `<li class="toc-i lv${x.lv}"><a href="#${esc(x.id)}" data-toc="${esc(x.id)}">${esc(x.text)}</a></li>`).join('');
  // 用 <details> 而不是自己写折叠：不用 JS 就能收起，键盘和读屏器也认。
  return `<details class="toc${opt.float ? ' toc-fix' : ''}" id="art-toc" open>` +
    '<summary class="toc-h">目录</summary>' +
    `<ul class="toc-list">${lis}</ul></details>`;
}

// 开关：没设过就是开（与 captcha 一个口径：未设置即默认开启）。
// 后台「设置 → 文章目录」里关掉，存成 '0'。
export const enabled = (s) => String((s && s.get ? s.get('toc_on') : '') || '') !== '0';

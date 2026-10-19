// 外链中转签名（Ver 0.6 ⑪）
// ---------------------------------------------------------------------------
// 由来：友链卡片会先落到 /jump/<links.id> 说明「要离开本站了」，但文章正文、
// 评论昵称、友圈标题这三处的外链一直是直接出站。这三处的目标地址不来自某张表，
// 而是作者 / 访客 / RSS 里现成的字符串 —— 没法像友链那样「只按 id 查库」。
//
// 如果直接把目标塞进地址栏（/jump?u=https://...），本站就成了开放重定向：
// 谁都能拿我们的域名发一条「看起来很可信」的钓鱼链接。所以地址里放的是
// **签名过的载荷**：u 是目标的 base64url，s 是 HMAC-SHA256(u) 的前 16 字节。
// 伪造不了 u，也就伪造不了跳转目标。
//
// 分工：
//   渲染层（同步）只写 `href="jump:<b64>"` 这种中间形态，不碰密钥；
//   响应出口（异步，见 [[path]].js 的 sealJump）统一换成带签名的 /jump?u=&s=。
//   这样 md.js / site.js 一个 async 都不用改，后台预览、RSS、静态导出也都不受影响
//   （它们不经过出口那一层，看到的仍是原始地址）。
import { esc } from './util.js';

const TAG = 'jump:';
const MAX_URL = 2048;
const TOKEN_RE = /href="jump:([A-Za-z0-9_-]+)"/g;

// 只认 http(s)：javascript: / data: / mailto: 一律不算外链（mailto 本来也不是网页）
export function safeJumpUrl(v) {
  const u = String(v == null ? '' : v).trim();
  return /^https?:\/\/[^\s]+$/i.test(u) && u.length <= MAX_URL ? u : '';
}

// UTF-8 → base64url。btoa 只吃 latin1，所以先过 TextEncoder 再逐字节拼字符串。
// 中文路径、emoji、& 之类的查询参数都能原样往返。
export function b64url(str) {
  const bytes = new TextEncoder().encode(String(str));
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64url(s) {
  const t = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = t.length % 4 ? '='.repeat(4 - (t.length % 4)) : '';
  const bin = atob(t + pad);              // 非法字符会抛，调用方负责 try/catch
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// 渲染层用：能中转就返回 jump:<b64>，地址不合法就原样返回（宁可直链，也不产出坏链接）
export function jumpHref(url) {
  const u = safeJumpUrl(url);
  return u ? TAG + b64url(u) : String(url == null ? '' : url);
}

// 正文是**落库的 HTML**（content_html），不能在保存时打标记，否则 RSS / 静态导出 /
// 导入到别家的数据里都会残留 jump:。所以只在文章页输出前过一道。
// 只改 <a href="http(s)://...">；站内相对路径、锚点、mailto 一概不动。
// 代码块里的 <a> 在 md.js 里已被转义成 &lt;a，不会被这条正则命中。
const A_HREF = /(<a\b[^>]*?\shref=")(https?:\/\/[^"]+)(")/gi;
const unent = (s) => s
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'");

export function jumpifyHtml(html) {
  return String(html == null ? '' : html).replace(A_HREF, (m, pre, href, post) => {
    const u = safeJumpUrl(unent(href));
    return u ? pre + TAG + b64url(u) + post : m;
  });
}

export const hasTokens = (html) => String(html == null ? '' : html).includes('href="' + TAG);

// ---- HMAC ----
// 每个请求都 importKey 一次太浪费；按密钥内容缓存（正常站点只有一把）。
const keyCache = new Map();
function keyOf(secret) {
  const k = String(secret || '');
  if (!keyCache.has(k)) {
    keyCache.set(k, crypto.subtle.importKey(
      'raw', new TextEncoder().encode(k),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    ));
  }
  return keyCache.get(k);
}

export async function sigOf(token, secret) {
  const key = await keyOf(secret);
  const buf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(String(token)));
  // 16 字节 = 128 位，比伪造者能碰运气的量级高得多，链接也不会长到难看
  return Array.from(new Uint8Array(buf).slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
}

// 常量时间比较：长度不同直接否，相同时逐字符异或累积
export function sameSig(a, b) {
  const x = String(a || ''), y = String(b || '');
  if (!x || x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0;
}

export async function verifyToken(token, sig, secret) {
  if (!token || !sig || !secret) return false;
  return sameSig(await sigOf(token, secret), sig);
}

// 出口用：把所有 jump:<b64> 换成带签名的地址。
// 同一个 token 只算一次 HMAC（一页里同一条链接可能出现多次）。
export async function signTokens(html, secret) {
  const src = String(html == null ? '' : html);
  if (!hasTokens(src)) return src;
  const toks = [...new Set([...src.matchAll(TOKEN_RE)].map((m) => m[1]))];
  const sigs = new Map();
  await Promise.all(toks.map(async (tk) => { sigs.set(tk, await sigOf(tk, secret)); }));
  return src.replace(TOKEN_RE, (m, tk) => `href="/jump?u=${tk}&amp;s=${sigs.get(tk)}"`);
}

// 没配 AUTH_SECRET 时的兜底：签不了名就别给坏链接，直接还原成原始地址。
// 这种情况下功能等于没开（和上线前一样是直链），不会把站点弄挂。
export function restoreTokens(html) {
  return String(html == null ? '' : html).replace(TOKEN_RE, (m, tk) => {
    let u = '';
    try { u = safeJumpUrl(unb64url(tk)); } catch (e) { u = ''; }
    return u ? `href="${esc(u)}"` : 'href="#"';
  });
}

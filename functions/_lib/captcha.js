// ============ 算术验证码：服务端生成 SVG 图片，无外部依赖 ============
// 思路：随机出一道 1~9 的加法题 → 把「答案 + 过期时间」用 HMAC 签名后写进
// HttpOnly Cookie（前端拿不到答案）→ 图片本体是带干扰背景的 SVG（防 OCR）。
import { readCookie } from './util.js';
import { secretOf } from './auth.js';

const enc = new TextEncoder();
const COOKIE = 'blog_cap';
const TTL = 30 * 60; // 验证码有效期（秒）

function b64u(b) {
  const u = new Uint8Array(b); let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64u(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
async function sign(env, payload) {
  const k = await crypto.subtle.importKey('raw', enc.encode(secretOf(env)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  return b64u(await crypto.subtle.sign('HMAC', k, enc.encode(payload)));
}
async function verifySig(env, payload, sigB64) {
  try {
    const k = await crypto.subtle.importKey('raw', enc.encode(secretOf(env)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    return await crypto.subtle.verify('HMAC', k, unb64u(sigB64), enc.encode(payload));
  } catch (e) { return false; }
}

const CH_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escCh = (s) => String(s).replace(/[&<>"']/g, (c) => CH_ESC[c]);

// 生成带干扰背景的验证码 SVG（字符随机旋转 + 噪点 + 干扰线 + 幻影重影）
function captchaSvg(text) {
  // 随机池取 512 个：一张图约需 300+ 次随机，池太小会导致噪点位置周期性重复
  const R = crypto.getRandomValues(new Uint32Array(512));
  let k = 0;
  const rnd = () => (R[k++ % 512] >>> 0) / 4294967296;
  const rr = (a, b) => a + rnd() * (b - a);
  const ri = (a, b) => Math.floor(rr(a, b + 1));
  const W = 150, H = 48;
  const h1 = ri(0, 359), h2 = (h1 + ri(60, 220)) % 360;

  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="算术验证码">`;
  // 渐变底
  s += `<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">`
    + `<stop offset="0" stop-color="hsl(${h1},62%,95%)"/><stop offset="1" stop-color="hsl(${h2},58%,90%)"/></linearGradient></defs>`;
  s += `<rect width="${W}" height="${H}" rx="8" fill="url(#bg)"/>`;
  // 背景色块
  for (let n = 0; n < 5; n++) {
    s += `<ellipse cx="${rr(0, W).toFixed(1)}" cy="${rr(0, H).toFixed(1)}" rx="${rr(10, 34).toFixed(1)}" ry="${rr(6, 18).toFixed(1)}" `
      + `fill="hsl(${ri(0, 359)},68%,${ri(70, 86)}%)" opacity="${rr(.16, .38).toFixed(2)}" `
      + `transform="rotate(${rr(0, 180).toFixed(1)} ${(W / 2).toFixed(1)} ${(H / 2).toFixed(1)})"/>`;
  }
  // 干扰曲线
  for (let n = 0; n < 6; n++) {
    s += `<path d="M${rr(-6, W).toFixed(1)} ${rr(-6, H).toFixed(1)} Q${rr(0, W).toFixed(1)} ${rr(0, H).toFixed(1)} ${rr(-6, W).toFixed(1)} ${rr(-6, H).toFixed(1)}" `
      + `fill="none" stroke="hsl(${ri(0, 359)},58%,${ri(34, 58)}%)" stroke-width="${rr(.8, 1.9).toFixed(1)}" opacity="${rr(.32, .68).toFixed(2)}"/>`;
  }
  // 噪点
  for (let n = 0; n < 48; n++) {
    s += `<circle cx="${rr(0, W).toFixed(1)}" cy="${rr(0, H).toFixed(1)}" r="${rr(.6, 1.8).toFixed(1)}" `
      + `fill="hsl(${ri(0, 359)},52%,${ri(30, 64)}%)" opacity="${rr(.22, .62).toFixed(2)}"/>`;
  }
  // 文字：逐字随机旋转/偏移 + 幻影重影。
  // ⚠️ 两道反爬：① 输出顺序打乱（源码顺序 ≠ 视觉顺序）；② 混入几乎不可见的诱饵字符。
  // 这样直接抓 SVG 源码也无法拼出算式，而且按 x 坐标排序同样会踩到诱饵；人类看图不受影响。
  const fs = 25;
  const glyphs = [];
  let x = 11;
  for (const ch of String(text)) {
    glyphs.push({
      ch, x: +x.toFixed(1), y: +(H / 2 + fs * 0.35 + rr(-3, 3)).toFixed(1),
      rot: +rr(-19, 19).toFixed(1), fill: `hsl(${ri(0, 359)},62%,${ri(20, 38)}%)`, decoy: false,
    });
    x += ch === ' ' ? 9 : ri(15, 18);
  }
  // 诱饵：透明度 5%~13%，肉眼几乎不可见，但在源码里与真字符同级
  const BAIT = '0123456789+=';
  for (let n = 0; n < 4; n++) {
    glyphs.push({
      ch: BAIT[ri(0, BAIT.length - 1)], x: +rr(8, W - 22).toFixed(1),
      y: +(H / 2 + fs * 0.35 + rr(-6, 6)).toFixed(1), rot: +rr(-25, 25).toFixed(1),
      fill: `hsl(${ri(0, 359)},58%,${ri(28, 48)}%)`, decoy: true, op: +rr(0.05, 0.13).toFixed(2),
    });
  }
  // Fisher–Yates 打乱输出顺序
  for (let i = glyphs.length - 1; i > 0; i--) { const j = ri(0, i); const t = glyphs[i]; glyphs[i] = glyphs[j]; glyphs[j] = t; }
  for (const g of glyphs) {
    const attr = `font-family="Consolas,Monaco,'Courier New',monospace" font-size="${fs}" font-weight="700"`;
    const tf = `transform="rotate(${g.rot} ${g.x} ${g.y})"`;
    if (g.decoy) {
      s += `<text x="${g.x}" y="${g.y}" ${attr} fill="${g.fill}" opacity="${g.op}" ${tf}>${escCh(g.ch)}</text>`;
    } else {
      // 先叠一层半透明幻影干扰 OCR，再画实体
      s += `<text x="${(g.x + rr(-2, 2)).toFixed(1)}" y="${g.y}" ${attr} fill="${g.fill}" opacity=".2" ${tf}>${escCh(g.ch)}</text>`;
      s += `<text x="${g.x}" y="${g.y}" ${attr} fill="${g.fill}" stroke="${g.fill}" stroke-width=".4" ${tf}>${escCh(g.ch)}</text>`;
    }
  }
  return s + '</svg>';
}

// 生成一道新题（返回题面文本、SVG、需要下发的 Cookie）
export async function newCaptcha(env) {
  const r = crypto.getRandomValues(new Uint32Array(4));
  const a = 1 + (r[0] % 9);
  const b = 1 + (r[1] % 9);
  const exp = Math.floor(Date.now() / 1000) + TTL;
  const payload = b64u(enc.encode(JSON.stringify({ s: a + b, e: exp, n: r[2] })));
  const token = payload + '.' + (await sign(env, payload));
  return {
    text: `${a} + ${b} = ?`,
    svg: captchaSvg(`${a} + ${b} = ?`),
    cookie: `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TTL}`,
    ttl: TTL,
  };
}

// 校验用户输入的答案
export async function checkCaptcha(env, req, answer) {
  const v = readCookie(req, COOKIE);
  if (!v) return false;
  const i = v.lastIndexOf('.');
  if (i < 1) return false;
  const payload = v.slice(0, i), sig = v.slice(i + 1);
  if (!(await verifySig(env, payload, sig))) return false;
  try {
    const p = JSON.parse(new TextDecoder().decode(unb64u(payload)));
    if (!p || !p.e || p.e < Date.now() / 1000) return false;
    const given = String(answer == null ? '' : answer).trim();
    if (!/^\d{1,3}$/.test(given)) return false;
    return Number(given) === Number(p.s);
  } catch (e) { return false; }
}

// Cookie 里是否有有效验证码（用于在没开启验证码时跳过、或页面首屏判断）
export const hasCaptchaCookie = (req) => !!readCookie(req, COOKIE);
export const clearCaptchaCookie = () => `${COOKIE}=; Path=/; HttpOnly; Max-Age=0`;

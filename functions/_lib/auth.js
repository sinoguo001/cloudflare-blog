// ============ 认证：PBKDF2 密码哈希 + HMAC 无状态会话 Cookie ============
import { readCookie } from './util.js';

const enc = new TextEncoder();
const ITER = 150000;

function hex(b) { return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join(''); }
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

export const newSalt = () => { const b = new Uint8Array(16); crypto.getRandomValues(b); return b64u(b); };
export function secretOf(env) { return env.AUTH_SECRET || 'dev-only-insecure-change-me'; }

export async function pbkdf2(pass, saltB64, iter = ITER) {
  const salt = unb64u(saltB64);
  const k = await crypto.subtle.importKey('raw', enc.encode(String(pass)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, k, 256);
  return hex(bits);
}

async function hmacKey(env) {
  return crypto.subtle.importKey('raw', enc.encode(secretOf(env)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function sign(env, payload) {
  const k = await hmacKey(env);
  return b64u(await crypto.subtle.sign('HMAC', k, enc.encode(payload)));
}
async function verifySig(env, payload, sigB64) {
  try {
    const k = await hmacKey(env);
    return await crypto.subtle.verify('HMAC', k, unb64u(sigB64), enc.encode(payload));
  } catch (e) { return false; }
}

// 生成会话值 value = b64url(json).sig
export async function makeSessionValue(env, username) {
  const payload = b64u(enc.encode(JSON.stringify({ u: username, e: Math.floor(Date.now() / 1000) + 7 * 86400 })));
  return payload + '.' + (await sign(env, payload));
}

export function setSessionCookie(value) {
  return `blog_session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`;
}
export function clearSessionCookie() {
  return 'blog_session=; Path=/; HttpOnly; Max-Age=0';
}

// 从请求还原当前登录用户名，未登录返回 null
export async function userFromRequest(env, req) {
  const v = readCookie(req, 'blog_session');
  if (!v) return null;
  const i = v.lastIndexOf('.');
  if (i < 1) return null;
  const payload = v.slice(0, i), sig = v.slice(i + 1);
  if (!(await verifySig(env, payload, sig))) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(unb64u(payload)));
    if (!p.u || p.e < Date.now() / 1000) return null;
    return p.u;
  } catch (e) { return null; }
}

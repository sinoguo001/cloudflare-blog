// ============================================================
// 边缘缓存（Cache API，Ver 0.5 ①）—— 让前台页面的绝大多数请求
// 不再跑 D1 查询与整页渲染。
//
// 为什么用 Cache API 而不是响应头（Cache-Control: s-maxage）：
//   1) Cloudflare 默认**不缓存 HTML**（只按扩展名缓存），光加响应头没用；
//   2) 边缘缓存命中时函数根本不会执行 —— 就没法按 Cookie 做例外，
//      而登录态（blog_session）和加密文章解锁态（pp<id>）的页面
//      是「因人而异」的，缓存出去会串号。
//   Cache API 由代码显式读写：先判断该不该缓存，再决定读不读，
//   顺序在我们手里，才安全。
//
// ⚠️ Cache API 不支持 stale-while-revalidate 指令，所以这里自己实现：
//   过期条目**先把旧的给访客**，同时在后台重渲染一份（waitUntil）。
//   否则低流量站点每次都会卡在「条目已过期 → 冷渲染」上，等于没缓存。
// ============================================================

export const FRESH_SEC = 600;    // 新鲜期：超过它就在后台刷一份新的
export const STORE_SEC = 86400;  // 条目最多留 24 小时（到点自然淘汰）

// Node 环境没有 caches（冒烟测试里由测试自己 stub）；没有就退化成「不缓存」
const getCache = () => (typeof caches !== 'undefined' && caches && caches.default) ? caches.default : null;
// 缓存键就是请求 URL 本身（不做自定义键，这样 purge API 能按 URL 精确清理）
const keyOf = (url) => new Request(url.toString(), { method: 'GET' });

// 能否走公共缓存：只有匿名请求。
// blog_session = 博主登录态；pp<数字> = 加密文章解锁态。这两类响应因人而异，必须绕开。
export function canCache(request) {
  if (!request) return false;
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  if (!getCache()) return false;
  const ck = request.headers.get('cookie') || '';
  if (/(?:^|;\s*)blog_session=/.test(ck)) return false;
  if (/(?:^|;\s*)pp\d+=/.test(ck)) return false;
  return true;
}

// 存进缓存的副本：只留 s-maxage。
// ⚠️ 不能带 max-age=0 —— cache.put 会把它判成「不允许缓存」并以 413 拒写。
function storeCopy(resp) {
  const h = new Headers(resp.headers);
  h.set('cache-control', 'public, s-maxage=' + STORE_SEC);
  h.set('x-cached-at', String(Math.floor(Date.now() / 1000)));
  h.delete('x-cache');        // 内部的「允许缓存」标记，不外传
  h.delete('x-edge-cache');   // 上一轮的 HIT/MISS 调试头，不能带进新副本
  h.delete('age');
  return new Response(resp.body, { status: resp.status, headers: h });
}

// 给访客的副本：浏览器每次都回边缘校验（max-age=0），内容一更新立刻可见。
function clientCopy(resp, state) {
  const h = new Headers(resp.headers);
  h.set('cache-control', 'public, max-age=0, must-revalidate');
  h.delete('x-cached-at');
  h.delete('x-cache');
  if (state) h.set('x-edge-cache', state);
  return new Response(resp.body, { status: resp.status, headers: h });
}

const stampOf = (resp) => parseInt(resp.headers.get('x-cached-at') || '0', 10) || 0;
export const isStale = (resp) => (Math.floor(Date.now() / 1000) - stampOf(resp)) > FRESH_SEC;

// 写缓存：任何失败都咽掉 —— 缓存是加分项，存不进去也不能影响正常响应
async function put(url, resp) {
  const c = getCache();
  if (!c) return false;
  try { await c.put(keyOf(url), storeCopy(resp)); return true; } catch (e) { return false; }
}
export async function save(url, resp) { return put(url, resp); }

// 读缓存。render 传「重新渲染这个页面的函数」：
// 条目过期时用它做后台刷新，返回 null 表示这一页不该缓存（就不写回去了）。
// read() 本身返回 null 表示未命中，调用方照常渲染。
export async function read(ctx, url, render) {
  const c = getCache();
  if (!c) return null;
  let hit = null;
  try { hit = await c.match(keyOf(url)); } catch (e) { return null; }
  if (!hit) return null;
  if (isStale(hit) && typeof render === 'function' && ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil((async () => {
      try {
        // render 返回 null 表示「按调用方的规则这页不该缓存」；status 非 200 一律不存
        const r = await render();
        if (r && r.status === 200) await put(url, r);
      } catch (e) { /* 后台刷新失败：旧的继续用，到点自然淘汰 */ }
    })());
  }
  return clientCopy(hit, 'HIT');
}

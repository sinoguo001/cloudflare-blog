// ============================================================
// 外站视频嵌入（Ver 0.5 ⑥）：B 站 / YouTube
// 设计要点：博主粘进来的是「视频页面地址」，但正文里落库的永远是这里拼出来的
// **播放器地址**。渲染时只从地址里取「哪家 + 哪个视频 ID」，再自己重建 iframe ——
// 所以就算有人在 Markdown 里手写一个 <iframe src="...">，只要主机不在白名单，
// 也只会被当普通文字转义掉，嵌入这一路不存在 XSS 缺口。
// b23.tv 分享短链需要出网读一次重定向才能拿到真实地址，这是本模块唯一的出网行为，
// 且每一跳都要求落在白名单内。
// ============================================================
export const EMBED_UA = 'Mozilla/5.0 (compatible; YunShangBlog/1.0; +video-embed)';

const SHORT_HOST = 'b23.tv';
const MAX_URL = 500;
const MAX_HOPS = 4;
const TIMEOUT_MS = 6000;

const BV_RE = /^BV[0-9A-Za-z]{10}$/;
const AID_RE = /^[1-9][0-9]{0,11}$/;
const YT_RE = /^[0-9A-Za-z_-]{6,20}$/;

// 域名相等或为其子域（`evilbilibili.com` 不能算，必须带点）
const hostIs = (h, base) => h === base || h.endsWith('.' + base);
const isBiliHost = (h) => hostIs(h, 'bilibili.com');
const isYtHost = (h) => hostIs(h, 'youtube.com') || hostIs(h, 'youtube-nocookie.com');

// 前端也用同一套判断决定「按普通视频插入还是按外站嵌入插入」
export function isEmbedUrl(raw) {
  let u;
  try { u = new URL(String(raw == null ? '' : raw).trim()); } catch (e) { return false; }
  const h = u.hostname.toLowerCase();
  return isBiliHost(h) || isYtHost(h) || h === SHORT_HOST;
}

// 从任意 B 站 / YouTube 地址里认出视频：返回 {provider,id}，认不出返回 null
export function identify(raw) {
  let u;
  try { u = new URL(String(raw == null ? '' : raw).trim()); } catch (e) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const h = u.hostname.toLowerCase();

  if (isBiliHost(h)) {
    // 播放器地址（app 分享出来的就是这种）
    if (h === 'player.bilibili.com') {
      const bv = u.searchParams.get('bvid') || '';
      if (BV_RE.test(bv)) return { provider: 'bilibili', id: bv };
      const aid = u.searchParams.get('aid') || '';
      if (AID_RE.test(aid)) return { provider: 'bilibili', id: 'av' + aid };
      return null;
    }
    // 视频页地址：/video/BVxxxxxxxxxx 或 /video/av123456
    const m = /^\/video\/(BV[0-9A-Za-z]{10}|av([1-9][0-9]{0,11}))(\/|$)/.exec(u.pathname);
    if (!m) return null;
    return m[2] ? { provider: 'bilibili', id: 'av' + m[2] } : { provider: 'bilibili', id: m[1] };
  }

  if (isYtHost(h)) {
    const v = u.searchParams.get('v') || '';
    if (YT_RE.test(v)) return { provider: 'youtube', id: v };
    const m = /^\/(?:embed|shorts|v)\/([0-9A-Za-z_-]{6,20})/.exec(u.pathname);
    if (m) return { provider: 'youtube', id: m[1] };
    return null;
  }

  if (hostIs(h, 'youtu.be')) {
    const id = u.pathname.replace(/^\/+/, '').split('/')[0];
    return YT_RE.test(id) ? { provider: 'youtube', id } : null;
  }
  return null;
}

// 播放器地址一律由这里生成；YouTube 用 youtube-nocookie（不种跟踪 Cookie）
export function playerSrc(e) {
  if (!e) return '';
  if (e.provider === 'bilibili') {
    const q = e.id.slice(0, 2) === 'av' ? 'aid=' + e.id.slice(2) : 'bvid=' + e.id;
    return 'https://player.bilibili.com/player.html?' + q + '&autoplay=0';
  }
  return 'https://www.youtube-nocookie.com/embed/' + e.id + '?rel=0';
}

const timeout = () => (typeof AbortSignal !== 'undefined' && AbortSignal.timeout
  ? AbortSignal.timeout(TIMEOUT_MS) : undefined);

// 跟一跳：优先用 manual 自己读 Location（能逐跳校验），
// 万一运行时在 manual 下不给 Location，就退回让运行时自己跟、用最终地址兜底。
async function followOnce(f, url) {
  const init = { method: 'GET', headers: { 'user-agent': EMBED_UA }, signal: timeout() };
  let res;
  try { res = await f(url, { ...init, redirect: 'manual' }); } catch (e) { return { next: '', status: 0 }; }
  const loc = res.headers.get('location');
  if (loc) return { next: new URL(loc, url).href, status: res.status };
  if (res.status >= 300 && res.status < 400) {
    try {
      const r2 = await f(url, { ...init, redirect: 'follow' });
      return { next: String(r2.url || ''), status: 200 };
    } catch (e) { return { next: '', status: 0 }; }
  }
  return { next: '', status: res.status };
}

// 把用户粘贴的地址解析成 {ok, provider, id, src}
// doFetch 可注入（测试里传假 fetch，不出网）
export async function resolveEmbed(raw, doFetch) {
  const src = String(raw == null ? '' : raw).trim().slice(0, MAX_URL);
  if (!src) return { ok: false, error: '请填写视频地址' };
  let u;
  try { u = new URL(src); } catch (e) { return { ok: false, error: '地址格式不正确（需要以 http:// 或 https:// 开头）' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: '地址格式不正确（需要以 http:// 或 https:// 开头）' };

  let cur = u.href;
  if (u.hostname.toLowerCase() === SHORT_HOST) {
    const f = doFetch || fetch;
    let landed = false;
    for (let hop = 0; hop < MAX_HOPS; hop++) {
      const r = await followOnce(f, cur);
      if (!r.next) return { ok: false, error: '短链没能解析出视频地址，请在浏览器打开后复制完整地址' };
      let nh = '';
      try { nh = new URL(r.next).hostname.toLowerCase(); } catch (e) { nh = ''; }
      // 短链只允许跳到 B 站自己的域名，别的一律拒绝
      if (nh !== SHORT_HOST && !isBiliHost(nh)) return { ok: false, error: '短链跳转到了不受支持的站点' };
      cur = r.next;
      if (nh !== SHORT_HOST) { landed = true; break; }
    }
    if (!landed) return { ok: false, error: '短链没能解析出视频地址，请在浏览器打开后复制完整地址' };
  }

  const e = identify(cur);
  if (!e) return { ok: false, error: '只支持 B 站（bilibili.com）与 YouTube 的视频地址' };
  return { ok: true, provider: e.provider, id: e.id, src: playerSrc(e) };
}

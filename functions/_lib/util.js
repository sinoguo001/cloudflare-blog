// ============ 通用小工具（Worker 端） ============
export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

export const err = (msg, status = 400) => json({ error: msg }, status);

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC_MAP[c]);

export function stripHtml(h) {
  return String(h || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

// 北京时间（UTC+8）字符串 'YYYY-MM-DD HH:MM:SS'
export const bnNow = () => {
  const d = new Date(Date.now() + 8 * 3600e3);
  return d.toISOString().slice(0, 19).replace('T', ' ');
};

export function fmtDate(s, time = false) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?/.exec(s || '');
  if (!m) return '';
  return time ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : `${m[1]}-${m[2]}-${m[3]}`;
}

const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
// 北京时间字符串 -> RFC1123（RSS 用）
export function rfc822(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(s || '');
  if (!m) return '';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  return `${DOW[d.getUTCDay()]}, ${String(d.getUTCDate()).padStart(2,'0')} ${MON[d.getUTCMonth()]} ${m[1]} ${m[4]}:${m[5]}:${m[6]} +0800`;
}

// 只保留 ascii 小写英文/数字 slug（中文标题留空走 "post-id" 自动别名）
export const slugify = (s) =>
  String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// LIKE 通配符转义
export function escLike(s) {
  return String(s || '').replace(/[\\%_]/g, (c) => '\\' + c);
}

export function readCookie(req, name) {
  const m = new RegExp('(?:^|;\\s*)' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^;]*)').exec(req.headers.get('cookie') || '');
  return m ? decodeURIComponent(m[1]) : null;
}

export const MIME_EXT = { png:'image/png', jpeg:'image/jpeg', jpg:'image/jpeg', gif:'image/gif',
  webp:'image/webp', avif:'image/avif', bmp:'image/bmp', ico:'image/x-icon', json:'application/json', txt:'text/plain',
  css:'text/css', svg:'image/svg+xml', woff2:'font/woff2', woff:'font/woff', xml:'application/xml', js:'application/javascript', webmanifest:'application/manifest+json' };
export const mimeOfExt = (f) => {
  const e = (String(f).split('.').pop() || '').toLowerCase();
  return MIME_EXT[e] || 'application/octet-stream';
};

export function paginate(page, per, total) {
  const pages = Math.max(1, Math.ceil(total / per));
  const p = Math.min(Math.max(1, page || 1), pages);
  return { p, pages, offset: (p - 1) * per };
}

export async function readJson(req) {
  try { return await req.json(); } catch (e) { return null; }
}

export const isHexColor = (s) => /^#[0-9a-fA-F]{6}$/.test(s || '');

// RSS / Sitemap「双形态」判别：浏览器直接打开 -> 排版 HTML；阅读器 / 爬虫 -> 标准 XML。
//
// ★ 坑（上一版栽过）：真实浏览器的 Accept 长这样
//     text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,*/*;q=0.8
//   里面**本来就有 application/xml**。所以绝不能拿「Accept 声明了 xml」当作「不是浏览器」的依据，
//   否则所有真实浏览器都会被误判成阅读器，HTML 分支永远走不到。
//   可靠信号是：浏览器一定声明 text/html 且 UA 带 Mozilla；而 RSS 阅读器只声明
//   application/rss+xml / application/xml，且 UA 是程序名。
const FEED_BOT_UA = /(?:bot\b|spider|crawl|slurp|feedfetcher|feedly|inoreader|newsblur|netnewswire|reeder|feedbin|theoldreader|rss(?:reader|parrot)?\b|validator|python-requests|python-urllib|\bcurl\b|\bwget\b|okhttp|java\/|go-http|libwww-perl|ahrefs|semrush|pingdom|monitoring|preview|headless)/i;

export function wantsFeedHtml(accept, ua, fmt) {
  if (fmt === 'html') return true;   // ?format=html 强制
  if (fmt === 'xml') return false;   // ?format=xml 强制（逃生舱）
  const a = String(accept || '');
  const u = String(ua || '');
  if (FEED_BOT_UA.test(u)) return false;                     // 爬虫 / 阅读器：一律 XML，保 SEO 与订阅
  if (/application\/(?:rss|atom)\+xml/i.test(a)) return false; // 显式声明订阅类型
  return /text\/html/i.test(a) && /Mozilla/i.test(u);        // 真浏览器
}

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

// 邮箱格式校验（只管格式，不验证是否真实存在、也不发验证邮件）
// 要求：本地部分不含空格与 @；域名各级以字母数字开头结尾（`-b.com` 这类不合法）、至少含一个点、顶级域 2 位以上字母
export const isEmail = (s) =>
  /^[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/.test(String(s || '').trim());

// 访客标识（仅用于 UV 去重：随机串，不含任何个人信息，1 年有效）
export const newVisitorId = () =>
  [...crypto.getRandomValues(new Uint8Array(12))].map((x) => x.toString(16).padStart(2, '0')).join('');

// ============ 访问统计防刷 ============
// 目标：蜘蛛与明显脚本请求「不计入统计、也不产生任何 D1 写入」。
// 判定由硬到软，命中任意一条即拒绝（返回原因串），全部通过才返回 null。
// 宁可漏计，也不让刷量把写入额度打爆——这是刻意的取舍。

// 蜘蛛 / 爬虫 / 命令行 / 无头浏览器 / 监控探测
const PV_BOT_UA = /(?:bot\b|spider|crawl|slurp|archiver|scrapy|python-requests|python-urllib|urllib|aiohttp|okhttp|java\/|go-http|libwww-perl|node-fetch|axios|headless|phantomjs|playwright|puppeteer|selenium|electron|monitor|pingdom|uptime|statuscake|semrush|ahrefs|mj12|dotbot|bytespider|yisou|sogou|youdao|ia_archiver|facebookexternalhit|twitterbot|telegrambot|whatsapp|embedly|feedfetcher|feedly|inoreader|newsblur|netnewswire|rss|validator|w3c_|preview|scanner|nikto|sqlmap|nmap|masscan|zgrab|lighthouse|gtmetrix|pagespeed|speedinsights|wget|\bcurl\b)/i;

// 机房 / 云主机 ASN 组织名关键词（request.cf.asOrganization，免费套餐即有）
// 只列明确的云厂商与机房词，不用裸 CLOUD / SERVER 这类泛词，避免误伤名字里带这些词的普通运营商
const CLOUD_ASN = ['AMAZON', 'AWS', 'GOOGLE-CLOUD', 'MICROSOFT', 'AZURE', 'ALIBABA', 'ALIYUN', 'TENCENT',
  'HUAWEI', 'QINGCLOUD', 'DIGITALOCEAN', 'HETZNER', 'OVH', 'VULTR', 'LINODE', 'SCALEWAY', 'LEASEWEB',
  'CONTABO', 'HOSTINGER', 'IONOS', 'ORACLE', 'AKAMAI', 'FASTLY', 'G-CORE', 'M247', 'DATACENTER', 'HOSTING',
  'VPS', 'DEDICATED'];

// 单实例限速：同一 IP 60 秒内超过 60 次视为刷量。
// 注意每个 isolate 内存独立，这条只能挡住「打在同一个实例上」的突发，
// 全局防线仍要靠 Cloudflare 面板的速率限制规则；但它零成本，值得留着。
const HIT_BUCKET = new Map();
const HIT_LIMIT = 60;
function tooManyHits(ip) {
  const now = Date.now();
  const w = HIT_BUCKET.get(ip);
  if (!w || now - w.t > 60000) {
    if (HIT_BUCKET.size > 2000) {
      for (const [k, v] of HIT_BUCKET) if (now - v.t > 60000) HIT_BUCKET.delete(k);
    }
    HIT_BUCKET.set(ip, { n: 1, t: now });
    return false;
  }
  w.n += 1;
  return w.n > HIT_LIMIT;
}

export function hitGuard(request) {
  const cf = request.cf || {};
  const ua = request.headers.get('user-agent') || '';

  // 1) Cloudflare 已识别的机器人（Bot Management，企业版字段；有值就信）
  const bm = cf.botManagement;
  if (bm && (bm.verifiedBot === true || (typeof bm.score === 'number' && bm.score < 15))) return 'bot-management';

  // 2) UA 形态：真实浏览器 UA 都够长且以 Mozilla/ 开头，脚本往往不是
  if (ua.length < 20 || !/Mozilla\//i.test(ua)) return 'ua-shape';
  if (PV_BOT_UA.test(ua)) return 'ua-bot';

  // 3) 机房 / 云主机出口
  const org = String(cf.asOrganization || '').toUpperCase();
  if (org && CLOUD_ASN.some((k) => org.includes(k))) return 'cloud-asn';

  // 4) 浏览器指纹：正常页面请求至少会带 accept-language 或 referer 之一，脚本常常两个都没有
  if (!request.headers.get('accept-language') && !request.headers.get('referer')) return 'no-browser-headers';

  // 5) 同源校验：存在则必须同源，挡住别的站点借访问者浏览器刷量
  const sfs = request.headers.get('sec-fetch-site');
  if (sfs && sfs !== 'same-origin') return 'cross-site';
  const og = request.headers.get('origin');
  if (og) {
    let host = '';
    try { host = new URL(og).host; } catch (e) { return 'bad-origin'; }
    if (host !== new URL(request.url).host) return 'bad-origin';
  }

  // 6) 单实例限速
  const ip = request.headers.get('cf-connecting-ip') || cf.ip || 'unknown';
  if (tooManyHits(ip)) return 'rate';

  return null;
}

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

// ---------- 永久链接（伪静态 / permalink） ----------
// 规则形如 /post/{slug}.html，可用变量：{slug} {id} {year} {month} {day} {category}。
// {slug} 与 {id} 至少有一个，否则多篇会撞到同一个地址、无法反查。
export const PERMALINK_DEFAULT = '/post/{slug}';
export const PERMALINK_VARS = ['slug', 'id', 'year', 'month', 'day', 'category'];
// 首段是"字面量"时不能占用这些系统路径：固定路由先于永久链接匹配，占了文章就永远打不开
const PERMALINK_RESERVED = new Set([
  'api', 'admin', 'media', 'theme-assets', 'backup', 'backups', 'preview',
  'category', 'categories', 'tag', 'tags', 'archive', 'search',
  'links', 'page', 'js', 'rss.xml', 'feed.xml', 'sitemap.xml', 'robots.txt',
  'favicon.svg', 'favicon.ico', 'p',   // p = 独立页面前缀 /p/<slug>，不能被文章规则占用
]);

// 规整并校验；不合法返回 ''（调用方据此保留原值或报错）
export function normalizePermalink(v) {
  let x = String(v == null ? '' : v).trim();
  if (!x) return '';
  if (x[0] !== '/') x = '/' + x;
  x = x.replace(/\/{2,}/g, '/');                 // 去掉空段
  if (x.length > 1) x = x.replace(/\/+$/, '');   // 去掉末尾斜杠
  if (!x || x.length > 120) return '';
  // 只允许路径安全字符与 {变量}：挡掉空格、中文、? # : 等会破坏 URL 的字符
  if (!/^[A-Za-z0-9\-_.~/{}]+$/.test(x)) return '';
  if (!/\{(slug|id)\}/.test(x)) return '';                                  // 必须能唯一定位
  const used = [...x.matchAll(/\{([a-zA-Z]+)\}/g)].map((m) => m[1]);
  if (used.some((k) => !PERMALINK_VARS.includes(k))) return '';             // 未知变量
  if (new Set(used).size !== used.length) return '';                        // 同一变量出现两次
  const first = x.split('/')[1] || '';
  if (first && !first.includes('{') && PERMALINK_RESERVED.has(first)) return '';
  return x;
}

// 从设置里取规则；没设过或非法则回退默认，保证前台永远能出链接
export function permalinkOf(s) {
  const v = s && typeof s.get === 'function' ? s.get('permalink') : '';
  return normalizePermalink(v) || PERMALINK_DEFAULT;
}

const RE_ESC = /[.*+?^${}()|[\]\\]/g;
// 规则 → 正则 + 变量名顺序（用于把请求路径反解回文章）
export function permalinkRegex(pat) {
  const keys = [];
  let src = '';
  const RX = /\{(slug|id|year|month|day|category)\}|[^{]+|\{/g;
  let m;
  while ((m = RX.exec(pat))) {
    if (m[1]) {
      keys.push(m[1]);
      if (m[1] === 'id') src += '(\\d+)';
      else if (m[1] === 'year') src += '(\\d{4})';
      else if (m[1] === 'month' || m[1] === 'day') src += '(\\d{2})';
      else src += '([^/]+)';
    } else if (m[0] === '{') {
      src += '\\{';                       // 单个左花括号（非变量）按字面处理
    } else {
      src += m[0].replace(RE_ESC, '\\$&');
    }
  }
  return { re: new RegExp('^' + src + '$'), keys };
}

// 文章各变量的取值，用于生成链接与校验 URL 是否与文章一致
export function permalinkVars(p) {
  const d = String((p && (p.published_at || p.created_at)) || '').slice(0, 10);
  return {
    slug: String((p && p.slug) || ''),
    id: String((p && p.id) || ''),
    year: d.slice(0, 4),
    month: d.slice(5, 7),
    day: d.slice(8, 10),
    category: (p && p.category && p.category.slug) || (p && p.cat_slug) || 'uncategorized',
  };
}

// 生成文章的访问地址（相对路径，模板里再 esc 后写入 href）
export function postUrl(s, p) {
  const pat = permalinkOf(s);
  const v = permalinkVars(p);
  return pat.replace(/\{(slug|id|year|month|day|category)\}/g, (_, k) => v[k] || (k === 'category' ? 'uncategorized' : ''));
}

// 独立页面（Ver 0.4）：地址固定为 /p/<slug>，不参与永久链接规则
export function pageUrl(p) {
  return '/p/' + String((p && p.slug) || '').replace(/^\/+|\/+$/g, '');
}

// 反解出来的变量是否与文章一致（文章改过发布时间或分类时，旧地址应 301 到新地址）
export function permalinkVarsMatch(kv, p) {
  const v = permalinkVars(p);
  for (const k of Object.keys(kv)) {
    if (kv[k] == null) continue;
    if (String(kv[k]) !== v[k]) return false;
  }
  return true;
}

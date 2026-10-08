// ============================================================
// 友圈（Ver 0.4 ⑫）：订阅别人的 RSS，把抓回来的文章落到 friend_posts
// Workers 里拿不到 DOMParser，所以解析全部走纯字符串扫描 —— 也正因为如此，
// 解析函数可以在本地 Node 里直接喂样例 XML 测试（见 .friends-smoke.mjs）。
// ============================================================
import { bnNow } from './util.js';
import * as db from './db.js';

// 抓取用的 UA：带上来源说明，免得被对面当成脚本直接拒
export const FEED_UA = 'Mozilla/5.0 (compatible; YunShangBlog/1.0; +friend-circle)';
const MAX_BYTES = 500 * 1024;   // 响应体上限，防超大文件拖垮内存
const MAX_ITEMS = 20;           // 每个源一次最多取这么多条
const MAX_SUMMARY = 160;        // 摘要截断长度

const bnStr = (d) => new Date(d.getTime() + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ');

// ---------- 地址安全 ----------
// 订阅地址是博主自己填的，但仍要挡住内网 / 回环 / 云元数据地址：
// 这个地址是服务端去请求的，不做限制就成了 SSRF（能借我们的出口探测内网）。
export function isFetchableUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch (e) { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (h === 'localhost' || /\.(localhost|local|internal|lan|home)$/.test(h)) return false;
  if (h.includes(':')) return false;   // IPv6 一律拒绝（[::1] 之类绕不过去）
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    const p = h.split('.').map(Number);
    if (p.some((x) => x > 255)) return false;
    if (p[0] === 0 || p[0] === 10 || p[0] === 127) return false;      // 本机 / 私有
    if (p[0] === 169 && p[1] === 254) return false;                   // 链路本地（云元数据）
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return false;       // 私有
    if (p[0] === 192 && p[1] === 168) return false;                   // 私有
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return false;      // 运营商级 NAT
    if (p[0] >= 224) return false;                                    // 组播 / 保留
  }
  return true;
}

// ---------- XML 清洗 ----------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const safeCp = (v) => { try { return String.fromCodePoint(v); } catch (e) { return ''; } };

// 块级标签换成空格（免得 <p>a</p><p>b</p> 粘成 ab），行内标签直接去掉
const BLOCK_TAG = /<\/?(p|div|br|hr|li|ul|ol|tr|th|td|h[1-6]|blockquote|section|article|figure|figcaption|pre|table|dl|dt|dd)\b[^>]*>/gi;
const stripTags = (s) => String(s == null ? '' : s).replace(BLOCK_TAG, ' ').replace(/<[^>]*>/g, '');
const decodeEnt = (s) => String(s == null ? '' : s)
  .replace(/&#x([0-9a-f]+);/gi, (m, h) => safeCp(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (m, d) => safeCp(parseInt(d, 10)))
  .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (m, k) => ENT[k]);

// 解 CDATA / 实体 / 去标签。顺序很重要：**先解实体再去标签** ——
// 很多源把 HTML 写成 &lt;p&gt;（Atom 的 type="html" 尤其常见），
// 反过来先剥标签的话这些实体形式的标签会被当成正文留下。
// CDATA 先挖出来存着，等普通路径处理完再单独清洗，否则里面的内容会被吃掉。
function decodeXml(s) {
  const cdata = [];
  let t = String(s == null ? '' : s);
  t = t.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (m, inner) => '\u0001' + (cdata.push(inner) - 1) + '\u0001');
  t = stripTags(decodeEnt(t));
  t = t.replace(/\u0001(\d+)\u0001/g, (m, i) => stripTags(decodeEnt(cdata[+i] == null ? '' : cdata[+i])));
  return t.replace(/\s+/g, ' ').trim();
}

// 取某个标签的文本（已清洗）；name 支持 content:encoded / dc:creator 这种带前缀的
function text(block, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('<' + esc + '\\b[^>]*>([\\s\\S]*?)</' + esc + '\\s*>', 'i');
  const m = re.exec(block);
  return m ? decodeXml(m[1]) : '';
}
// 取原始文本（不去标签），交给 cleanSummary 自己清洗
function rawText(block, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('<' + esc + '\\b[^>]*>([\\s\\S]*?)</' + esc + '\\s*>', 'i');
  const m = re.exec(block);
  return m ? m[1] : '';
}
const firstOf = (block, names, raw = false) => {
  for (const n of names) {
    const v = raw ? rawText(block, n) : text(block, n);
    if (v) return v;
  }
  return '';
};

// 只放行 http(s) 的绝对地址；相对地址用源站地址补全
function absUrl(raw, base = '') {
  let u = decodeXml(String(raw == null ? '' : raw));
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u.slice(0, 500);
  if (/^\/\//.test(u)) u = 'https:' + u;
  else if (base) { try { u = new URL(u, base).href; } catch (e) { return ''; } }
  return /^https?:\/\//i.test(u) ? u.slice(0, 500) : '';
}

// Atom 的 <link href>：优先 rel="alternate"，跳过 self / enclosure
function pickLink(block, base) {
  const tags = block.match(/<link\b[^>]*>/gi) || [];
  for (const t of tags) {
    const h = /href\s*=\s*["']([^"']+)["']/i.exec(t);
    if (h && !/rel\s*=\s*["'](self|enclosure|replies)["']/i.test(t)) return absUrl(h[1], base);
  }
  for (const t of tags) {
    const h = /href\s*=\s*["']([^"']+)["']/i.exec(t);
    if (h) return absUrl(h[1], base);
  }
  const m = /<link\b[^>]*>([\s\S]*?)<\/link>/i.exec(block);   // RSS 2.0 的 <link>文本</link>
  return m ? absUrl(m[1], base) : '';
}

// 发布时间：RFC 822（RSS）与 ISO 8601（Atom）都交给 Date.parse；
// 但 "2026-09-01 12:00:00" 这种没带时区的写法必须先拦下来按北京时间算，
// 否则会按服务器时区（UTC）解释，凭空年轻 8 小时。
export function parseFeedDate(s) {
  const t = String(s == null ? '' : s).trim();
  if (!t) return '';
  const naive = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*$/.exec(t);
  if (naive) {
    return bnStr(new Date(Date.UTC(+naive[1], +naive[2] - 1, +naive[3],
      +(naive[4] || 0) - 8, +(naive[5] || 0), +(naive[6] || 0))));
  }
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? bnStr(new Date(ms)) : '';
}

// 摘要：去标签、解实体、压空白、截断
export function cleanSummary(html, n = MAX_SUMMARY) {
  const t = decodeXml(html);
  return t.length > n ? t.slice(0, n) + '…' : t;
}

// ---------- 解析 ----------
// 同时认 RSS 2.0（<item>）与 Atom（<entry>）。导出成纯函数，测试直接喂字符串。
export function parseFeed(xml, baseUrl = '') {
  const src = String(xml == null ? '' : xml)
    .replace(/^\uFEFF/, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  const re = /<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  const items = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(src))) {
    if (items.length >= MAX_ITEMS) break;
    const b = m[2];
    const title = text(b, 'title');
    const link = pickLink(b, baseUrl);
    if (!title && !link) continue;
    const guid = (text(b, 'guid') || text(b, 'id') || link || title).slice(0, 300);
    if (seen.has(guid)) continue;
    seen.add(guid);
    items.push({
      guid,
      title: (title || link).slice(0, 200),
      link,
      summary: cleanSummary(firstOf(b, ['description', 'summary', 'content', 'content:encoded'], true)),
      author: firstOf(b, ['dc:creator', 'author', 'name']).slice(0, 60),
      published_at: parseFeedDate(firstOf(b, ['pubDate', 'published', 'updated', 'dc:date'])) || bnNow(),
    });
  }
  // 频道级信息：把条目段挖掉再取，免得把第一篇文章的标题当成站点名
  const head = src.replace(re, '');
  return {
    title: text(head, 'title').slice(0, 80),
    siteUrl: absUrl(text(head, 'link'), baseUrl) || (baseUrl ? absUrl('/', baseUrl) : ''),
    description: cleanSummary(firstOf(head, ['description', 'subtitle', 'tagline'], true), 80),
    items,
  };
}

// ---------- 抓取 ----------
// 单条订阅：返回 { ok, status, title, siteUrl, items } 或 { ok:false, error }
export async function fetchFeed(url, { timeoutMs = 8000, fetchImpl } = {}) {
  if (!isFetchableUrl(url)) return { ok: false, status: 0, error: '地址不合法：只支持公网 http / https 地址' };
  const f = fetchImpl || globalThis.fetch;
  if (typeof f !== 'function') return { ok: false, status: 0, error: '当前环境不支持网络请求' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), Math.max(1000, timeoutMs));
  try {
    const res = await f(url, {
      signal: ctl.signal,
      redirect: 'follow',
      headers: {
        'user-agent': FEED_UA,
        accept: 'application/rss+xml,application/atom+xml,application/xml,text/xml;q=0.9,*/*;q=0.8',
      },
    });
    if (!res || !res.ok) {
      return { ok: false, status: (res && res.status) || 0, error: '对方返回 HTTP ' + ((res && res.status) || '?') };
    }
    const raw = String(await res.text()).slice(0, MAX_BYTES);
    let base = '';
    try { base = new URL(url).origin; } catch (e) { base = ''; }
    const parsed = parseFeed(raw, base);
    if (!parsed.items.length) {
      return { ok: false, status: res.status, error: '没解析到文章：这个地址可能不是 RSS / Atom 订阅' };
    }
    return { ok: true, status: res.status, title: parsed.title, siteUrl: parsed.siteUrl, items: parsed.items };
  } catch (e) {
    const msg = String((e && e.message) || e);
    return { ok: false, status: 0, error: /abort|timeout/i.test(msg) ? '抓取超时' : ('抓取失败：' + msg.slice(0, 120)) };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 刷新 ----------
// 是否到了该刷的时候（lastAt 是北京时间字符串；空 = 从没刷过）
export function feedStale(lastAt, ttlMinutes = 30) {
  const t = String(lastAt || '').trim();
  if (!t) return true;
  const ms = Date.parse(t.replace(' ', 'T') + 'Z');
  if (!Number.isFinite(ms)) return true;
  return Date.now() - (ms - 8 * 3600e3) >= ttlMinutes * 60e3;
}

// 刷新订阅：不传 ids 就按「最久没刷的优先」取 limit 条（一次抓太多会拖长请求）
export async function refreshFeeds(env, { ids = null, limit = 3, timeoutMs = 8000, fetchImpl } = {}) {
  const dbx = env.DB;
  let feeds = await db.listFeeds(dbx, { enabledOnly: true });
  if (Array.isArray(ids) && ids.length) {
    const want = ids.map((x) => parseInt(x, 10));
    feeds = feeds.filter((f) => want.includes(f.id));
  } else {
    feeds = feeds
      .slice()
      .sort((a, b) => String(a.last_fetch || '').localeCompare(String(b.last_fetch || '')))
      .slice(0, Math.max(1, limit));
  }
  if (!feeds.length) return [];
  // 并行抓：串行的话 3 条 × 8 秒超时就把 waitUntil 的额度吃光了
  const results = await Promise.all(feeds.map(async (f) => {
    const r = await fetchFeed(f.url, { timeoutMs, fetchImpl });
    const patch = { last_fetch: bnNow(), last_status: 0, last_error: '' };
    if (r.ok) {
      // Ver 0.5 ⑤：白名单源抓回来直接放行；不在白名单的源先落 pending，等后台审核
      await db.saveFeedItems(dbx, f.id, r.items, bnNow(), { approved: !!f.whitelist });
      // 兜底：白名单源不该压着待审（比如白名单是直接在库里改的），刷新时顺手放行
      if (f.whitelist) await db.approveFeedPosts(dbx, f.id).catch(() => {});
      patch.last_status = r.status || 200;
      if (!f.name && r.title) patch.name = String(r.title).slice(0, 40);   // 名字留空 → 用对方源标题
      if (!f.site_url && r.siteUrl) patch.site_url = r.siteUrl;
      await db.markFeedResult(dbx, f.id, patch);
      return { id: f.id, ok: true, count: r.items.length };
    }
    patch.last_status = r.status || 0;
    patch.last_error = String(r.error || '抓取失败').slice(0, 200);
    await db.markFeedResult(dbx, f.id, patch);
    return { id: f.id, ok: false, error: patch.last_error };
  }));
  // 记下整轮刷新的时间：前台按这个判断"该不该再去后台抓一次"
  await db.setSetting(dbx, 'friends_refresh_at', bnNow()).catch(() => {});
  return results;
}

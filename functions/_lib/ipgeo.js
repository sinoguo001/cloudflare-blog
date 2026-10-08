// ============================================================
// IP 归属地查询（Ver 0.5 ⑦）
//
// 把访客 IP 查成「位置 + 运营商」，缓存进 ip_geo 表，供后台与前台展示。
//
// 设计上的三个关键取舍：
//  1. 只查公网 IP。内网、回环、Cloudflare 拿不到 IP 时的占位值一律跳过 ——
//     发给接口也只能得到空结果，白费一次出网请求。
//  2. 缓存优先。同一个 IP 只对第三方发一次请求（免费接口都限流，
//     而且博客访客重复 IP 很常见），命中缓存直接返回，零出网。
//  3. 前台只读缓存、绝不出网。页面渲染里塞几十个外部请求会把首屏拖死，
//     何况前台是有边缘缓存的，渲染期发请求等于把第三方延迟焊进缓存副本。
//
// 三家接口的格式差别（都实测过）：
//   百度   location="江苏省南京市 电信"          UTF-8   省市与运营商一句话给全（默认）
//   太平洋 pro/city/region，addr="广东省广州市番禺区电信" GBK 运营商粘在 addr 尾巴上，得裁掉省市前缀
//   纯真   country="中国–浙江–杭州"，local=运营商  UTF-8   位置与运营商分得最干净
// ★ 太平洋是 GBK！直接 r.json() 会解出乱码，必须先 TextDecoder('gbk') 再 JSON.parse。
// ★ 太平洋的 http 版返回 403，只有 https 能通（实测）。
// ============================================================

export const PROVIDERS = [
  { id: 'baidu', name: '百度（推荐 · 省市与运营商一次给全）' },
  { id: 'pconline', name: '太平洋电脑网（能到区，如「广州市番禺区」）' },
  { id: 'zxinc', name: '纯真 IP 库（位置与运营商分列）' },
];
export const DEFAULT_PROVIDER = 'baidu';
const IDS = PROVIDERS.map((p) => p.id);
export const isProvider = (id) => IDS.includes(String(id == null ? '' : id));
/** 设置里没配、或配了个不认识的 id（比如以后删掉了某个接口），都落到默认接口 */
export const pickProvider = (id) => (isProvider(id) ? String(id) : DEFAULT_PROVIDER);

const GEO_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const GEO_TIMEOUT = 5000;
// 查不到的结果只保留一天：接口临时抽风不该让某个 IP 一辈子挂不上归属地，
// 但也不能每次打开后台都对着同一批查不到的 IP 反复出网。
const STALE_FAIL_MS = 24 * 3600e3;

// 库里时间一律用北京时间字符串，与其它表一致，可直接比大小
const bnNow = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ');

// ---------- 公网 IP 判断 ----------
export function isPublicIp(raw) {
  const ip = String(raw == null ? '' : raw).trim();
  if (!ip || ip === 'unknown' || ip === '-' || ip === '::1') return false;
  return ip.includes(':') ? isPublicV6(ip) : isPublicV4(ip);
}
function isPublicV4(ip) {
  const p = ip.split('.');
  if (p.length !== 4) return false;
  const n = [];
  for (const s of p) {
    if (!/^\d{1,3}$/.test(s)) return false;
    const v = parseInt(s, 10);
    if (v > 255) return false;
    n.push(v);
  }
  const [a, b] = n;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;     // 私有
  if (a === 192 && b === 168) return false;              // 私有
  if (a === 169 && b === 254) return false;              // 链路本地
  if (a === 100 && b >= 64 && b <= 127) return false;    // 运营商级 NAT
  if (a >= 224) return false;                            // 组播 / 保留
  return true;
}
function isPublicV6(ip) {
  const s = ip.toLowerCase().replace(/^\[/, '').replace(/\]$/, '').split('%')[0];
  if (s === '::' || s === '::1') return false;
  const head = s.split(':')[0];
  if (head.startsWith('fc') || head.startsWith('fd')) return false; // 唯一本地地址
  if (head.startsWith('fe8') || head.startsWith('fe9') ||
      head.startsWith('fea') || head.startsWith('feb')) return false; // 链路本地
  return true;
}

// ---------- 各家返回的解析 ----------
/** 「北京市北京市」压成「北京市」；「江苏省南京市」保持原样 */
function dedupeCity(loc) {
  const s = String(loc || '');
  const m = /^(.+?(?:省|市|自治区|特别行政区))(.+)$/.exec(s);
  if (m && m[2] === m[1]) return m[1];
  return s;
}
function parseBaidu(j) {
  const d = j && j.data && j.data[0];
  const raw = String((d && d.location) || '').trim();
  if (!raw) return null;
  // 「江苏省南京市 电信」：空格前是位置，空格后是运营商
  const parts = raw.split(/\s+/);
  return { loc: dedupeCity(parts[0] || ''), isp: parts.slice(1).join(' ').trim() };
}
function parsePconline(j) {
  if (!j) return null;
  const err = String(j.err || '').trim();
  // err=noprovince 是查不到省份（国外 IP），此时 addr 里是「美国」这类国家名
  if (err) {
    const a = String(j.addr || '').trim();
    return a ? { loc: a, isp: '' } : null;
  }
  const pro = String(j.pro || '').trim();
  const city = String(j.city || '').trim();
  let region = String(j.region || '').trim();
  if (region === pro) region = '';                    // 数据脏时 region 会填成省名
  const loc = (pro + city + (region === city ? '' : region)).trim();
  if (!loc) return null;
  // 运营商粘在 addr 尾巴上：「广东省广州市番禺区电信」→ 把用过的省市名逐个剪掉
  let isp = String(j.addr || '').trim();
  for (const part of [pro, city, region]) if (part) isp = isp.split(part).join('');
  return { loc, isp: isp.trim() };
}
function parseZxinc(j) {
  const d = j && j.data;
  if (!d) return null;
  const loc = String(d.country || '').trim()
    .replace(/^中国\s*[–—-]\s*/, '')   // 去掉国家前缀，本项目只关心国内位置
    .replace(/[–—]/g, '');             // 全角连接符换掉：「浙江–杭州」→「浙江杭州」
  const isp = String(d.local || '').trim();
  if (!loc && !isp) return null;
  return { loc, isp };
}
const PARSERS = { baidu: parseBaidu, pconline: parsePconline, zxinc: parseZxinc };

export function endpoint(provider, ip) {
  const q = encodeURIComponent(ip);
  if (provider === 'pconline') return `https://whois.pconline.com.cn/ipJson.jsp?json=true&ip=${q}`;
  if (provider === 'zxinc') return `https://ip.zxinc.org/api.php?type=json&ip=${q}`;
  return `https://opendata.baidu.com/api.php?query=${q}&co=&resource_id=6006&oe=utf8`;
}

// ---------- 单次查询 ----------
/**
 * @returns {{ok:true,loc:string,isp:string}|{ok:false,reason:string}}
 * reason: private（非公网 IP）/ net（出网失败）/ http（状态码非 2xx）/ json / empty
 */
export async function lookup(ip, provider, opts = {}) {
  if (!isPublicIp(ip)) return { ok: false, reason: 'private' };
  const p = pickProvider(provider);
  const f = opts.fetch || (typeof fetch === 'function' ? fetch : null);
  if (!f) return { ok: false, reason: 'net' };
  const ms = opts.timeout || GEO_TIMEOUT;
  const ac = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ac ? setTimeout(() => { try { ac.abort(); } catch (e) { /* 已结束 */ } }, ms) : null;
  if (timer && typeof timer.unref === 'function') timer.unref();
  let r;
  try {
    r = await f(endpoint(p, ip), {
      headers: { 'user-agent': GEO_UA, accept: 'application/json, text/plain, */*' },
      signal: ac ? ac.signal : undefined,
    });
  } catch (e) {
    if (timer) clearTimeout(timer);
    return { ok: false, reason: 'net' };
  }
  if (timer) clearTimeout(timer);
  if (!r || !r.ok) return { ok: false, reason: 'http' };
  let j;
  try {
    // ★ 太平洋返回的是 GBK（Content-Type: text/html; charset=GBK），
    //   走 r.json() 会把中文解成乱码。按响应头的 charset 判断，是 GBK 就先转码。
    const ct = String((r.headers && r.headers.get && r.headers.get('content-type')) || '');
    if (/gbk|gb2312|gb18030/i.test(ct)) {
      const buf = await r.arrayBuffer();
      j = JSON.parse(new TextDecoder('gbk').decode(buf));
    } else {
      j = await r.json();
    }
  } catch (e) {
    return { ok: false, reason: 'json' };
  }
  const g = (PARSERS[p] || parseBaidu)(j);
  if (!g || (!g.loc && !g.isp)) return { ok: false, reason: 'empty' };
  return { ok: true, loc: String(g.loc).slice(0, 60), isp: String(g.isp).slice(0, 40) };
}

// ---------- 缓存读写 ----------
/**
 * 只读缓存：把一批 IP 的归属地取回来，不出网。
 * 前台渲染必须走这个（见文件头第 3 条）。查不到 / 查失败过的 IP 不会出现在结果里。
 */
export async function geoMap(db, ips) {
  const uniq = [...new Set((ips || []).map((s) => String(s == null ? '' : s).trim()).filter(Boolean))];
  const out = new Map();
  if (!uniq.length) return out;
  for (let i = 0; i < uniq.length; i += 60) {
    const part = uniq.slice(i, i + 60);
    const r = await db.prepare(
      `SELECT ip,loc,isp,ok FROM ip_geo WHERE ip IN (${part.map(() => '?').join(',')})`
    ).bind(...part).all().catch(() => null);
    for (const row of ((r && r.results) || [])) {
      if (row.ok) out.set(row.ip, { loc: row.loc || '', isp: row.isp || '' });
    }
  }
  return out;
}

/**
 * 查一批 IP 并写缓存：并发发起、逐个落库，单个失败不影响其余。
 * 已有缓存的直接跳过；查失败的也记一笔（ok=0），一天内不再重复出网。
 */
export async function geoSync(db, ips, provider, opts = {}) {
  const p = pickProvider(provider);
  const uniq = [...new Set((ips || []).map((s) => String(s == null ? '' : s).trim()).filter(isPublicIp))];
  if (!uniq.length) return { checked: 0, cached: 0, failed: 0, skipped: (ips || []).length };
  const known = new Set();
  for (let i = 0; i < uniq.length; i += 40) {
    const part = uniq.slice(i, i + 40);
    const r = await db.prepare(
      `SELECT ip,ok,updated_at FROM ip_geo WHERE ip IN (${part.map(() => '?').join(',')})`
    ).bind(...part).all().catch(() => null);
    for (const row of ((r && r.results) || [])) {
      if (row.ok) { known.add(row.ip); continue; }
      const t = Date.parse(String(row.updated_at || '').replace(' ', 'T') + 'Z');
      if (Number.isFinite(t) && Date.now() - t < STALE_FAIL_MS) known.add(row.ip); // 失败记录未过期，先不重试
    }
  }
  const todo = uniq.filter((ip) => !known.has(ip));
  if (!todo.length) return { checked: 0, cached: uniq.length, failed: 0, skipped: 0 };
  const now = bnNow();
  let ok = 0, failed = 0;
  await Promise.all(todo.map(async (ip) => {
    const g = await lookup(ip, p, opts);
    if (g.ok) ok++; else failed++;
    await db.prepare('INSERT OR REPLACE INTO ip_geo(ip,loc,isp,ok,src,updated_at) VALUES(?,?,?,?,?,?)')
      .bind(ip, g.ok ? g.loc : '', g.ok ? g.isp : '', g.ok ? 1 : 0, g.ok ? p : '', now)
      .run().catch(() => { /* 缓存写失败不影响调用方，下次再查 */ });
  }));
  return { checked: todo.length, cached: uniq.length - todo.length, failed, skipped: 0 };
}

// ---------- 展示 ----------
/** 「位置 运营商」；国外 IP 常常只有国家名，这时就没有后面那一段 */
export function geoText(loc, isp) {
  const a = String(loc || '').trim();
  const b = String(isp || '').trim();
  if (!a) return b;
  if (!b || a.includes(b)) return a;
  return a + ' ' + b;
}

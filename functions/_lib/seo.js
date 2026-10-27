// ============ 搜索引擎主动推送（Ver 0.8 ①） ============
// 目的：文章发布 / 更新后主动把地址递过去，不用干等搜索引擎自己爬。
//
// 支持两家（都是「填一个密钥就能用」，不需要在站点里放文件）：
//   - 百度「普通收录」API：搜索资源平台 → 普通收录 → API 提交，拿到准入密钥；
//     POST 纯文本、一行一个 URL，站点必须在平台里验证过归属。
//   - IndexNow：必应 / Yandex / Seznam / Naver 共用一套，提交一次全网都收到通知；
//     要求用站点根下的 <key>.txt 证明这个域名归你 —— 那份文件由本站自动提供
//     （见 [[path]].js 里的 key 文件路由），所以后台只需要填 key。
//
// Google 没有通用网页的主动提交接口（Indexing API 只覆盖招聘页与直播页），
// 它只认 sitemap 与抓取 —— 这里不假装支持，也不发无效请求。
//
// 设计约束：
//   - 一律由调用方用 ctx.waitUntil 触发，搜索引擎慢不慢跟「文章存没存进去」无关；
//   - 任何异常都吞掉并落成一条可读状态，绝不让推送影响保存结果；
//   - 密钥只写不读（设置接口不回传），这里也不打印。

const BAIDU_API = 'http://data.zz.baidu.com/urls';
const INDEXNOW_API = 'https://api.indexnow.org/indexnow';
const TIMEOUT_MS = 8000;
// 百度单次最多 10 条；IndexNow 允许更多，但本站一次只推一两条，统一按 10 收
const MAX_URLS = 10;

// 百度准入密钥：官方没有公开固定长度，按 6–80 位字母数字收，太严会把合法值挡在外面
export const safeToken = (v) => {
  const t = String(v ?? '').trim();
  return /^[A-Za-z0-9_-]{6,80}$/.test(t) ? t : '';
};
// IndexNow 密钥：官方要求 8–128 位，只允许 a-z A-Z 0-9 与连字符
export const safeKey = (v) => {
  const t = String(v ?? '').trim();
  return /^[A-Za-z0-9-]{8,128}$/.test(t) ? t : '';
};

const get = (s, k) => String((s && typeof s.get === 'function' ? s.get(k) : (s || {})[k]) ?? '').trim();

// 站点根地址：优先用设置里的 site_url（自定义域），没配或填坏了回落到本次请求的 origin。
// ⚠️ 从 pages.dev 后台发文时 origin 是 *.pages.dev，百度会以 not_same_site 拒收 ——
//    所以「站点地址」配了就用它，别让用户被这个坑绕住。
export function siteBase(s, origin) {
  const raw = get(s, 'site_url');
  if (raw) {
    try { return new URL(raw).origin; } catch { /* 填坏了走下面的回落 */ }
  }
  return String(origin || '').replace(/\/+$/, '');
}

export function config(s, origin) {
  return {
    on: get(s, 'seo_push_on') === '1',
    baidu: safeToken(get(s, 'baidu_token')),
    indexnow: safeKey(get(s, 'indexnow_key')),
    base: siteBase(s, origin),
  };
}

// 带超时的 fetch：Workers 的 waitUntil 有生命周期，卡住的请求会连带整批结果一起丢
async function req(url, init) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

const brief = (s, n = 120) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

async function baidu(cfg, urls) {
  let host = '';
  try { host = new URL(cfg.base).host; } catch { return { name: '百度', ok: false, msg: '站点地址不合法' }; }
  const u = new URL(BAIDU_API);
  u.searchParams.set('site', host);   // 百度认 host（可带端口），不认带协议的完整地址
  u.searchParams.set('token', cfg.baidu);

  let res;
  try {
    res = await req(u.toString(), {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: urls.join('\n'),
    });
  } catch (e) {
    return { name: '百度', ok: false, msg: e && e.name === 'AbortError' ? '请求超时（8 秒）' : '请求失败' };
  }

  let data = null;
  try { data = await res.json(); } catch { data = null; }

  // 百度把业务错误也放在 200 的 body 里，所以先看 error 再 HTTP 状态
  if (data && data.error) {
    const map = {
      401: '准入密钥无效',
      400: '请求参数不对，检查密钥与站点',
      402: '站点未在百度验证归属',
      403: '配额已用完（普通收录每天有上限）',
      404: '接口地址不对（代理拦截？）',
    };
    return { name: '百度', ok: false, msg: map[data.error] || brief(data.message, 80) || ('错误码 ' + data.error) };
  }
  if (!res.ok) return { name: '百度', ok: false, msg: 'HTTP ' + res.status };

  const success = Number(data && data.success) || 0;
  if (success > 0) return { name: '百度', ok: true, msg: `成功 ${success} 条` };

  // success=0 不一定算失败：已收录的地址会被跳过，not_same_site 才是真错
  const bad = [];
  if (data && Array.isArray(data.not_same_site) && data.not_same_site.length) bad.push('站点与百度验证的不一致');
  if (data && Array.isArray(data.not_valid) && data.not_valid.length) bad.push('地址格式不被接受');
  if (bad.length) return { name: '百度', ok: false, msg: bad.join('；') };
  return { name: '百度', ok: true, msg: '已提交（百度未新增，可能已收录）' };
}

async function indexnow(cfg, urls) {
  let host = '';
  try { host = new URL(cfg.base).host; } catch { return { name: 'IndexNow', ok: false, msg: '站点地址不合法' }; }

  let res;
  try {
    res = await req(INDEXNOW_API, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        host,
        key: cfg.indexnow,
        // 本站自动托管这份文件；搜索引擎会先 GET 它来确认域名归属
        keyLocation: cfg.base + '/' + cfg.indexnow + '.txt',
        urlList: urls,
      }),
    });
  } catch (e) {
    return { name: 'IndexNow', ok: false, msg: e && e.name === 'AbortError' ? '请求超时（8 秒）' : '请求失败' };
  }

  if (res.status === 200) return { name: 'IndexNow', ok: true, msg: '已接收' };
  if (res.status === 202) return { name: 'IndexNow', ok: true, msg: '已接收（密钥待验证）' };
  const map = {
    400: '请求格式不对',
    403: '密钥无效（检查 IndexNow 密钥）',
    422: '地址不属于这个站点',
    429: '请求太频繁，稍后会自动再推',
  };
  return { name: 'IndexNow', ok: false, msg: map[res.status] || ('HTTP ' + res.status) };
}

// 返回 null 表示「没开 / 没配 / 没有 URL」，调用方据此不写状态
export async function push(cfg, urls) {
  if (!cfg || !cfg.on) return null;
  const list = [...new Set((urls || []).filter(Boolean))].slice(0, MAX_URLS);
  if (!list.length) return null;

  const jobs = [];
  if (cfg.baidu) jobs.push(baidu(cfg, list));
  if (cfg.indexnow) jobs.push(indexnow(cfg, list));
  if (!jobs.length) return null;

  const items = await Promise.all(jobs);
  return { ok: items.every((i) => i.ok), items, ts: Date.now() };
}

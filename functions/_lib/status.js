// ============================================================
// 站点热力图 + 服务器状态（Ver 0.7 ⑤）
//
// 两个侧边栏挂件的数据与渲染都放在这里，sidebar.js 只做接线 ——
// 那边已经够长，再加两百行就没法读了。
//
// ⚠️ 口径先说清楚：
//   1) 热力图只统计「文章」与「评论」，独立页面（type='page'）不算文章；
//      评论只算审核通过的。两者都按**北京时间**的日期切天，
//      因为库里存的 published_at / created_at 本身就是 UTC+8 字符串。
//   2) 「服务器状态」在 Workers 上**读不到 CPU / 内存 / 磁盘** ——
//      那几项没有可用的运行时接口，硬写只能是编的。这里换成本站
//      真实可测的指标（数据库往返耗时、库体积、R2 媒体量、待审评论、
//      运行天数），再叠一层可选的 Cloudflare Analytics。
//      Cloudflare 那层没配 Token 就整块不输出，绝不显示假数字。
// ============================================================
import { esc, bnNow } from './util.js';
import * as db from './db.js';

// 26 周（半年）。侧边栏内容宽约 262px，26 列时每格约 8px；
// 放到 53 周就只剩 3px 一列，深浅还能看出个大概，但点不中、也数不清。
export const HEAT_WEEKS = 26;

// 允许调用方指定，测试里传固定日期才能断言（生产的首次调用用 bnNow 的北京时间）
const clampWeeks = (n) => {
  const v = parseInt(n, 10);
  return Number.isFinite(v) ? Math.min(53, Math.max(8, v)) : HEAT_WEEKS;
};

const pad2 = (n) => String(n).padStart(2, '0');
const ymdOf = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
};
const utcOf = (y) => {
  const p = y.split('-').map(Number);
  return Date.UTC(p[0], p[1] - 1, p[2]);
};
const ymdOfUTC = (t) => {
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
};
const addDays = (y, n) => ymdOfUTC(utcOf(y) + n * 86400000);
// 0=周日 … 6=周六 → 换成 0=周一 … 6=周日（中文日历习惯周一打头）
const dowOf = (y) => (new Date(utcOf(y)).getUTCDay() + 6) % 7;
const diffDays = (a, b) => Math.round((utcOf(b) - utcOf(a)) / 86400000);

export const fmtNum = (n) => String(Math.max(0, Math.round(Number(n) || 0)))
  .replace(/\B(?=(\d{3})+(?!\d))/g, ',');

export function fmtBytes(n) {
  let v = Number(n) || 0;
  if (v < 0) v = 0;
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  if (i === 0) return Math.round(v) + ' B';
  return (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + ' ' + u[i];
}

// ------------------------------------------------------------
// 一、热力图数据
// 返回 null 表示没有任何内容（全站没发过文章、也没有通过审核的评论），
// 这时挂件整体不输出 —— 一个全空的方格阵没有任何信息量。
// ------------------------------------------------------------
export async function heatData(DB, opts = {}) {
  if (!DB) return null;
  const weeks = clampWeeks(opts.weeks);
  // ★ bnNow() 返回「北京时间」字符串，前 10 位就是北京的今天。
  //   绝不能拿 new Date() 去取，Workers 跑在 UTC，会差 8 小时、
  //   在东八区凌晨那几小时里整整错一天。
  const today = ymdOf(opts.today) || bnNow().slice(0, 10);
  // 右端取**今天所在这一周的周日**，再往前推 26 整周 —— 这样网格是完整的矩形
  // （最后一周不会缺角），今天永远在窗口内，右侧多出来的那几天标成 future 不显示。
  // 若改成「最后一格正好是今天」，窗口左端就会落在周中，整个网格错位一格。
  const endDay = addDays(today, 6 - dowOf(today));
  const start = addDays(endDay, -(weeks * 7 - 1));
  const stop = addDays(today, 1);   // 右开区间

  const r = await DB.prepare(
    `SELECT d, SUM(ap) AS ap, SUM(ac) AS ac FROM (
       SELECT substr(published_at,1,10) AS d, 1 AS ap, 0 AS ac FROM posts
        WHERE status='published' AND type='post' AND published_at>=? AND published_at<?
       UNION ALL
       SELECT substr(created_at,1,10) AS d, 0 AS ap, 1 AS ac FROM comments
        WHERE status='approved' AND created_at>=? AND created_at<?
     ) GROUP BY d`
  ).bind(start, stop, start, stop).all();

  const hit = new Map();
  for (const x of (r && r.results) || []) {
    const d = ymdOf(x.d);
    if (!d) continue;
    hit.set(d, { p: Number(x.ap) || 0, c: Number(x.ac) || 0 });
  }

  const cells = [];
  let totalPosts = 0;
  let totalComments = 0;
  for (let i = 0; i < weeks * 7; i++) {
    const d = addDays(start, i);
    const h = hit.get(d) || { p: 0, c: 0 };
    const future = diffDays(today, d) > 0;
    // future 的格子照样输出（保住网格的形状），只是不显示 —— 否则最后一周会缺角
    cells.push({ d, p: h.p, c: h.c, future });
    if (!future) { totalPosts += h.p; totalComments += h.c; }
  }
  if (!totalPosts && !totalComments) return null;

  // 月份标签：按**每列周一的月份**打点（不是按「1 日落在哪个列」——
  // 窗口 4/28 起时，5 月 1 日就落在第一列，那样会把 4 月标成 5 月）。
  // 相邻标签至少隔 4 列，否则「4月」「5月」会贴在一起；被跳过的那一列不补，
  // 上一个月标签自然覆盖那段宽度。
  const months = [];
  let prevM = 0;
  for (let col = 0; col < weeks; col++) {
    const m = parseInt(addDays(start, col * 7).slice(5, 7), 10);
    if (m === prevM) continue;
    if (!months.length || col + 1 - months[months.length - 1].col >= 4) {
      months.push({ col: col + 1, label: m + '月' });
    }
    prevM = m;
  }

  return { weeks, start, today, cells, months, totalPosts, totalComments };
}

// 数量 → 色阶（0 空，1 浅 … 4 最深）
const levelOf = (n) => (n <= 0 ? 0 : n === 1 ? 1 : n <= 2 ? 2 : n <= 4 ? 3 : 4);

export function renderHeat(m) {
  if (!m || !m.cells || !m.cells.length) return '';
  const CELLS = m.cells.map((x) => {
    if (x.future) return '<i class="sd-hc out"></i>';
    const n = x.p + x.c;
    const lv = levelOf(n);
    // 双色：当天哪一类多就用哪一类的色相，深浅看两类之和。
    // 相等时偏向文章 —— 写一篇比留一条言更值得在热力图上被看见。
    const kind = (x.c > x.p) ? 'c' : 'p';
    const cls = lv ? `sd-hc ${kind} lv${lv}` : 'sd-hc';
    const tip = n
      ? `${x.d} · 文章 ${x.p} 篇，评论 ${x.c} 条`
      : `${x.d} · 没有发布`;
    return `<i class="${cls}" title="${esc(tip)}"></i>`;
  }).join('');

  const MON = m.months.map((x) =>
    `<span style="grid-column:${x.col}/span 3">${x.label}</span>`).join('');

  const DOW = ['一', '', '三', '', '五', '', '日']
    .map((t) => `<i>${t}</i>`).join('');

  return `<div class="sd-heat">
    <div class="sd-hbox">
      <div class="sd-hdow">${DOW}</div>
      <div class="sd-hmain">
        <div class="sd-hmon" style="grid-template-columns:repeat(${m.weeks},1fr)">${MON}</div>
        <div class="sd-hgrid" style="grid-template-columns:repeat(${m.weeks},1fr)">${CELLS}</div>
      </div>
    </div>
    <div class="sd-hlg">
      <span><i class="sd-hdot p"></i>文章 ${fmtNum(m.totalPosts)} 篇</span>
      <span><i class="sd-hdot c"></i>评论 ${fmtNum(m.totalComments)} 条</span>
    </div>
    <div class="sd-hnote">近 ${m.weeks} 周 · 每格一天</div>
  </div>`;
}

// ------------------------------------------------------------
// 二、服务器状态
// ------------------------------------------------------------
const MEDIA_TTL = 3600e3;   // R2 统计缓存 1 小时：list 是分页接口，每次渲染都扫一遍太浪费
const CF_TTL = 3600e3;      // Cloudflare 统计同样 1 小时
const D1_FREE_BYTES = 5 * 1024 ** 3;    // D1 免费版 5GB
const R2_FREE_BYTES = 10 * 1024 ** 3;   // R2 免费版 10GB

async function dbBytes(DB) {
  // D1 对 PRAGMA 的支持随版本变化，拿不到就当没有 —— 绝不用别的数字顶替
  try {
    const a = await DB.prepare('PRAGMA page_count').first();
    const b = await DB.prepare('PRAGMA page_size').first();
    const n = Number(a && (a.page_count != null ? a.page_count : Object.values(a)[0]));
    const z = Number(b && (b.page_size != null ? b.page_size : Object.values(b)[0]));
    if (n > 0 && z > 0) return n * z;
  } catch (e) { /* 不支持就算了 */ }
  return 0;
}

async function scanR2(B) {
  let cursor = null;
  let n = 0;
  let bytes = 0;
  let pages = 0;
  let truncated = false;
  do {
    const r = await B.list({ limit: 1000, cursor });
    const list = (r && r.objects) || [];
    for (const o of list) { n++; bytes += Number(o.size) || 0; }
    cursor = r && r.truncated ? r.cursor : null;
    // 5 页（5000 个对象）封顶。首次渲染会**同步**扫一次（之后走 1 小时缓存），
    // 页数不设上限的话，媒体上万的站点首屏要发几十次子请求 —— Workers 单请求的
    // 子请求数是有上限的，而且用户要一直等到扫完。超过就标「≥N」，够用了。
    if (cursor && ++pages >= 5) { truncated = true; break; }
  } while (cursor);
  return { at: Date.now(), n, bytes, truncated };
}

export async function mediaStats(env, s, ctx) {
  const B = env && env.BLOG;
  if (!B || typeof B.list !== 'function') return null;
  let snap = null;
  try { snap = JSON.parse(s.get('_media_stat') || 'null'); } catch (e) { snap = null; }
  const fresh = snap && Number(snap.at) && Date.now() - Number(snap.at) < MEDIA_TTL;
  if (fresh) return snap;

  const save = async (v) => {
    try { await db.setSetting(env.DB, '_media_stat', JSON.stringify(v)); } catch (e) { /* 缓存写不进不影响页面 */ }
  };
  const job = () => scanR2(B).then((v) => { save(v); return v; });

  // 有旧快照就先用旧的、后台刷 —— 过期一小时的数字远好过让访客等一轮 R2 分页
  if (snap && Number(snap.at)) {
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(job().catch(() => {}));
    return snap;
  }
  try { return await job(); } catch (e) { return null; }
}

function cfErrText(j) {
  if (!j) return '没有返回内容';
  const e = (j.errors && j.errors[0]) || null;
  const t = e && (e.message || e.code) ? String(e.message || e.code) : '';
  return t ? t.slice(0, 120) : '查询失败';
}

async function fetchCf(token, zone) {
  const until = new Date();
  const since = new Date(Date.now() - 24 * 3600e3);
  const q = 'query($z:String!,$a:Time!,$b:Time!){viewer{zones(filter:{zoneTag:$z}){'
    + 'httpRequests1hGroups(limit:24,filter:{datetime_geq:$a,datetime_leq:$b},orderBy:[datetime_ASC])'
    + '{sum{requests bytes cachedBytes}}}}}';
  const r = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify({ query: q, variables: { z: zone, a: since.toISOString(), b: until.toISOString() } }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || j.errors || !j.data) {
    return { at: Date.now(), ok: false, why: '* ' + cfErrText(j) };
  }
  const zones = (j.data.viewer && j.data.viewer.zones) || [];
  const rows = (zones[0] && zones[0].httpRequests1hGroups) || [];
  if (!rows.length) return { at: Date.now(), ok: false, why: '最近 24 小时没有数据（Zone ID 填错或站点尚未接管流量）' };
  let requests = 0, bytes = 0, cached = 0;
  for (const x of rows) {
    const sm = x.sum || {};
    requests += Number(sm.requests) || 0;
    bytes += Number(sm.bytes) || 0;
    cached += Number(sm.cachedBytes) || 0;
  }
  return {
    at: Date.now(), ok: true, requests, bytes, cached,
    // 命中率按**字节**算：按请求数算会把一堆 304 小响应算成高命中，看着好看但不真实
    rate: bytes > 0 ? cached / bytes : 0,
  };
}

export async function cfStats(env, s, ctx) {
  const token = String(s.get('cf_api_token') || '').trim();
  const zone = String(s.get('cf_zone_id') || '').trim();
  if (!token || !zone) return null;   // 没配就整块不显示，不占地方

  let snap = null;
  try { snap = JSON.parse(s.get('_cf_stat') || 'null'); } catch (e) { snap = null; }
  if (snap && Number(snap.at) && Date.now() - Number(snap.at) < CF_TTL) return snap;

  const save = async (v) => {
    try { await db.setSetting(env.DB, '_cf_stat', JSON.stringify(v)); } catch (e) { /* 同上 */ }
  };
  const job = async () => {
    let v;
    try { v = await fetchCf(token, zone); } catch (e) { v = { at: Date.now(), ok: false, why: (e && e.message) || '请求失败' }; }
    await save(v);
    return v;
  };

  if (snap && Number(snap.at)) {
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(job().catch(() => {}));
    return snap;
  }
  return job();
}

export async function serverModel(env, s, ctx) {
  const DB = env && env.DB;
  if (!DB) return null;

  const t0 = Date.now();
  let row = null;
  let dbOk = true;
  try {
    row = await DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM posts WHERE status='published' AND type='post') AS posts,
         (SELECT COUNT(*) FROM comments WHERE status='approved') AS comments,
         (SELECT COUNT(*) FROM comments WHERE status='pending') AS pending,
         (SELECT MIN(published_at) FROM posts
           WHERE status='published' AND type='post'
             AND published_at IS NOT NULL AND published_at<>'') AS first_at`
    ).first();
  } catch (e) { dbOk = false; }
  // 这次查询本身就是「数据库响应」的实测值，不再单独发一条 SELECT 1
  const ms = Date.now() - t0;

  const posts = Number(row && row.posts) || 0;
  const comments = Number(row && row.comments) || 0;
  const pending = Number(row && row.pending) || 0;
  const firstAt = ymdOf(row && row.first_at);
  const alive = firstAt ? Math.max(1, diffDays(firstAt, bnNow().slice(0, 10)) + 1) : 0;

  const bytes = await dbBytes(DB).catch(() => 0);
  const media = await mediaStats(env, s, ctx).catch(() => null);
  const cf = await cfStats(env, s, ctx).catch(() => null);

  if (!dbOk && !posts && !comments) return null;
  return { dbOk, ms, posts, comments, pending, alive, bytes, media, cf };
}

const bar = (pct, tone) => {
  const w = Math.max(0, Math.min(100, Number(pct) || 0));
  return `<div class="sd-svbar"><i class="${tone || ''}" style="width:${w.toFixed(1)}%"></i></div>`;
};

const rowOf = (label, value, tip, cls) =>
  `<div class="sd-svr"><span>${esc(label)}</span><b${cls ? ` class="${cls}"` : ''}`
  + `${tip ? ` title="${esc(tip)}"` : ''}>${esc(value)}</b></div>`;

export function renderServer(m) {
  if (!m) return '';
  const parts = [];

  const ok = m.dbOk;
  parts.push(`<div class="sd-svst ${ok ? 'ok' : 'bad'}"><i></i>${ok ? '运行正常' : '数据库暂时不可用'}</div>`);

  // 延迟用**颜色**表达，不画进度条：进度条的语义是「用了多少」，
  // 而延迟越低越好 —— 画成条会出现「越快越空」，读起来是拧的。
  // 300ms 以上算慢（Worker 到 D1 的正常往返是个位数到几十毫秒）。
  // 本地 / 低延迟时会是 0，直接写「0 ms」像是没测到，写成 <1 更准确。
  const tone = m.ms > 300 ? 'bad' : (m.ms > 100 ? 'warn' : 'ok');
  parts.push(rowOf('数据库响应', m.ms < 1 ? '<1 ms' : m.ms + ' ms', '绿 <100ms，黄 100–300ms，红 >300ms', tone));

  if (m.bytes > 0) {
    // ★ 这里**不画进度条**：数据库体积占 D1 免费额度 5GB 常常只有 0.00x%，
    //   条永远是空的 —— 一条恒为 0 的进度条不传达任何信息，只是视觉噪声。
    //   百分比放进 title（鼠标停一下就能看到），版面留白比假象好。
    parts.push(rowOf('数据库体积', fmtBytes(m.bytes), '占 D1 免费额度 5GB 的 ' + (m.bytes / D1_FREE_BYTES * 100).toFixed(2) + '%'));
  }
  if (m.media) {
    const n = Number(m.media.n) || 0;
    const label = (m.media.truncated ? '≥' + fmtNum(n) : fmtNum(n)) + ' 个 · ' + fmtBytes(m.media.bytes);
    parts.push(rowOf('媒体库', label, '占 R2 免费额度 10GB 的 ' + ((Number(m.media.bytes) || 0) / R2_FREE_BYTES * 100).toFixed(2) + '%'));
  }

  parts.push(`<div class="sd-svkv">
    <span><b>${fmtNum(m.posts)}</b>文章</span>
    <span><b>${fmtNum(m.comments)}</b>评论</span>
    <span><b>${m.alive ? fmtNum(m.alive) : '—'}</b>天</span>
  </div>`);

  if (m.pending > 0) {
    parts.push(`<div class="sd-svpend">有 ${fmtNum(m.pending)} 条评论等待审核</div>`);
  }

  if (m.cf) {
    if (m.cf.ok) {
      parts.push(`<div class="sd-svsep">Cloudflare · 近 24 小时</div>`);
      parts.push(rowOf('请求', fmtNum(m.cf.requests)));
      parts.push(rowOf('流量', fmtBytes(m.cf.bytes)));
      parts.push(rowOf('缓存命中', (m.cf.rate * 100).toFixed(0) + '%'));
      parts.push(bar(m.cf.rate * 100, 'ok'));
    } else {
      // 配了但没跑通，必须让人看见 —— 静默隐藏会让人以为自己没填对
      parts.push(`<div class="sd-svsep">Cloudflare 统计</div>`);
      parts.push(`<div class="sd-svwarn" title="${esc(m.cf.why || '')}">暂不可用（${esc(String(m.cf.why || '').slice(0, 40))}）</div>`);
    }
  }

  return `<div class="sd-sv">${parts.join('')}</div>`;
}

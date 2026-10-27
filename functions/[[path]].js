// ============================================================
// Pages Functions 唯一入口（catch-all）
// 负责：/api/* 接口、/media/* R2 图片代理、前台页面 SSR、
//       rss.xml / sitemap.xml / robots.txt、后台静态资源(经 ASSETS)
// ============================================================
import { json, err, esc, bnNow, bnFromUTC, readJson, mimeOfExt, isHexColor, isEmail, stripHtml, wantsFeedHtml, readCookie, newVisitorId, hitGuard,
  normalizePermalink, permalinkOf, permalinkRegex, postUrl, pageUrl, catUrl, permalinkVarsMatch,
  sha256Hex, safeEqual, postPassCookie, parseRange, MEDIA_TYPES, MEDIA_MAX, mediaKindOf,
  putUpload } from './_lib/util.js';
// cloudflare:sockets 必须静态 import：Pages Functions 的打包器只稳妥支持顶层静态导入，
// 动态 import('cloudflare:sockets') 在真机上可能加载失败，表现为接口直接 5xx。
// 传给 mail.js 而不是让它自己 import —— 这样本地 Node 测试仍能注入假 socket。
import { connect } from 'cloudflare:sockets';
import { render } from './_lib/md.js';
import { mailConfigFrom, mailConfigError, renderMail, sendMailWithTimeout, describeCfg, mailPortIssue } from './_lib/mail.js';
import { CODE_THEMES } from './_lib/hl.js';
import * as db from './_lib/db.js';
import * as site from './_lib/site.js';
import * as feed from './_lib/feed.js';
import * as cache from './_lib/cache.js';
import * as purge from './_lib/purge.js';
import { buildSidebar, normalizeItems } from './_lib/sidebar.js';
import { resolveEmbed } from './_lib/embed.js';
import * as font from './_lib/font.js';
import * as audio from './_lib/audio.js';
import * as ipgeo from './_lib/ipgeo.js';
import * as sqldump from './_lib/sql.js';
// 目标程序导出（Ver 0.6 ⑧ 第二步）：Typecho / Z-Blog / WordPress 的表结构 + 字段映射
import * as targets from './_lib/targets.js';
// 导出静态站点（Ver 0.6 ⑧）：Markdown（Hexo 惯例）+ 零依赖 ZIP 打包
import * as hexo from './_lib/hexo.js';
import * as jump from './_lib/jump.js';
import * as zip from './_lib/zip.js';
// 数据导入（Ver 0.7 ①）：只负责白名单与写库，SQL 解析在浏览器端做（理由见文件头注释）
import * as importdb from './_lib/importdb.js';
// 搜索引擎主动推送（Ver 0.8 ①）：百度普通收录 + IndexNow（必应等）
import * as seo from './_lib/seo.js';
import { ADMIN_SHELL } from './_lib/admin-shell.js';
import * as presets from './_lib/presets.js';
import { newSalt, pbkdf2, userFromRequest, makeSessionValue, setSessionCookie, clearSessionCookie } from './_lib/auth.js';
import { newCaptcha, checkCaptcha, clearCaptchaCookie } from './_lib/captcha.js';

// .sql 下载响应。刻意不加 BOM：MySQL 客户端和 sqlite3 CLI 都可能把 BOM 当成正文第一个字符。
// 前端用 fetch + blob 落地，Content-Type 只作标识用。
const sqlFile = (text, fn) => new Response(text, {
  headers: {
    'content-type': 'application/sql; charset=utf-8',
    'content-disposition': `attachment; filename="${fn}"`,
    // 导出的是「此刻」的库，任何缓存都只会给出过期的数据
    'cache-control': 'no-store',
  },
});

// 静态站点导出件的下载响应。
// ⚠️ 这里必须传**二进制**（Uint8Array / ArrayBuffer），不能像上面那份 .sql 一样直接给字符串：
//    Response 会把字符串按 UTF-8 编码，zip 里的 PNG、JPEG 当场就烂了。
const zipFile = (body, fn) => new Response(body, {
  headers: {
    'content-type': 'application/zip',
    'content-disposition': `attachment; filename="${fn}"`,
    // 与 .sql 同理：导出的是此刻的内容，任何缓存都只会给出过期数据
    'cache-control': 'no-store',
  },
});

// 用户上传的目标程序建表脚本存在 R2：schema/target-<key>.sql
// 它只用来「学表名与列名」（认自定义前缀、跟版本漂移），那份 DDL 原文一律不输出。
const targetSchemaKey = (k) => 'schema/target-' + k + '.sql';
async function readTargetSchema(env, toKey, prefix) {
  const obj = await env.BLOG.get(targetSchemaKey(toKey));
  if (!obj) return null;
  const tables = targets.parseSchema(await obj.text(), prefix);
  return tables.length ? tables : null;
}

// 携带 Set-Cookie 的 JSON 响应
const jset = (data, cookie, status = 200) => {
  const r = json(data, status);
  if (cookie) r.headers.set('Set-Cookie', cookie);
  return r;
};

// R2 里所有上传文件的键都以 media/ 开头（备份在 backups/、主题在 themes/）
const MEDIA_PREFIX = 'media/';
const mediaLimitMsg = (kind, max) => `${kind === 'video' ? '视频' : kind === 'audio' ? '音频' : '图片'}不能超过 ${Math.round(max / 1048576)}MB`;

// 友圈（Ver 0.4 ⑫）：前台访问 /friends 时，若距上次抓取超过这个分钟数，
// 就用 waitUntil 在后台补一轮 —— 访客不等抓取，但数据会自己变新。
const FRIEND_TTL_MIN = 30;
const FRIEND_PER_PAGE = 20;

// IP 归属地（Ver 0.5 ⑦）：后台打开评论页时，一次请求最多补查这么多个 IP。
// 一页可能列出上百个不同 IP，全查会把请求时间和第三方额度一起耗光，
// 剩下的留给下次打开评论页继续补 —— 反正是缓存，补一个少一个。
const GEO_SYNC_MAX = 12;

export async function onRequest(ctx) {
  try {
    // 所有 HTML 响应在这里统一过一道：渲染层留下的 jump:<b64> 标记，到出口才换成
    // 带 HMAC 签名的 /jump?u=&s= 地址（理由见 sealJump）。
    return await sealJump(await handle(ctx), ctx.env);
  } catch (e) {
    console.error('route error:', e);
    return err('服务器内部错误：' + e.message, 500);
  }
}

// 外链中转标记的出口处理（Ver 0.6 ⑪）
// 为什么不在渲染时签：md.js / site.js 全是同步函数，HMAC 是异步的；而且同一份 HTML
// 还要喂给 RSS、静态导出、后台预览，那几处必须保持原始地址。放在出口只影响浏览器
// 真正看到的那一份。只碰 text/html：JSON 接口、静态资源、RSS/XML 原样放行。
async function sealJump(resp, env) {
  if (!resp || resp.status === 204 || resp.status === 304) return resp;
  if (!/text\/html/i.test(resp.headers.get('content-type') || '')) return resp;
  const text = await resp.text();
  const out = text.includes('href="jump:')
    ? (env && env.AUTH_SECRET
      ? await jump.signTokens(text, env.AUTH_SECRET)
      : jump.restoreTokens(text))   // 没配密钥就别生成坏链接，退回直链
    : text;
  // body 已经被读掉，必须重建；content-length / content-encoding 交给运行时重算
  const h = new Headers(resp.headers);
  h.delete('content-length');
  h.delete('content-encoding');
  return new Response(out, { status: resp.status, statusText: resp.statusText, headers: h });
}

const STATIC_EXT = /\.(css|js|mjs|png|jpe?g|gif|webp|avif|svg|ico|woff2?|txt|xml|webmanifest|json|map)$/i;

async function handle(ctx) {
  const { request, env } = ctx;
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const seg = decodeURIComponent(path).split('/').filter(Boolean); // 去掉首空段

  // ---- API ----
  if (seg[0] === 'api') return api(ctx, url, seg.slice(1), method);

  // ---- IndexNow 密钥文件（Ver 0.8 ①）----
  // 必应 / Yandex 等要求用站点根下的 <key>.txt 证明域名归属，内容就是这个 key 本身。
  // ⚠️ 必须排在下面「静态资源」分支之前：.txt 命中 STATIC_EXT，会被直接交给 ASSETS
  //    变成 404。这里只拦「填了 key 且路径正好对上」的那一个，不匹配就继续往下走，
  //    站点里原有的任何 .txt 行为都不变。
  if (method === 'GET' && /^\/[A-Za-z0-9-]{8,128}\.txt$/.test(path)) {
    const sk = await db.settingsMap(env.DB);
    const key = seo.safeKey(sk.get('indexnow_key'));
    if (key && path === '/' + key + '.txt') {
      return new Response(key, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=300' } });
    }
  }
  // ---- 后台静态资源与根静态文件 ----
  // （/media、/backup、robots/rss/sitemap 等动态路径需排除，避免被扩展名规则截胡）
  // ⚠️ fonts 必须在这里排除：.woff2 / .ttf 都命中下面的 STATIC_EXT，
  //    不排除的话 /fonts/xxx.woff2 会被当成静态资源交给 ASSETS，结果是 404。
  const isDynamicExt = seg[0] === 'media' || seg[0] === 'backup' || seg[0] === 'backups' || seg[0] === 'theme-assets' || seg[0] === 'fonts'
    || ['rss.xml', 'feed.xml', 'sitemap.xml', 'robots.txt'].includes(path.slice(1)) || path === '/favicon.svg';
  if (seg[0] === 'admin' || (STATIC_EXT.test(path) && !isDynamicExt) || path === '/favicon.ico') {
    const target = new URL(request.url);
    if (seg[0] === 'admin' && seg.length === 1) {
      // 规范化为目录 URL（/admin → /admin/）交给静态层服务 index.html。
      // ⚠️ 不能改写成 /admin/index.html：Pages 平台硬编码会把 xxx/index.html 请求
      // 308 重定向回 xxx/，而 /admin 又在 catch-all 内，形成 308 死循环（"重定向过多"）。
      if (!path.endsWith('/')) target.pathname += '/';
    }
    const res = await env.ASSETS.fetch(new Request(target, request));
    if (seg[0] !== 'admin') return res;
    // 后台只有博主一个人用，一律 no-cache（每次带 ETag 回源校验，文件没变仍是 304），改完刷新就见效。
    // ⚠️ 不能只靠 public/_headers：本项目的所有请求都先进这个 catch-all，
    //    响应由 Functions 生成，而 _headers 只作用于「平台直接吐出的静态资源」，
    //    对 Functions 的响应不生效 —— /admin/js/app.js 因此一直拿平台默认的
    //    max-age=14400（4 小时），于是「后台 JS 改完、刷新还是旧的」
    //    （2026-10-14 段落块就是这么被吃掉的）。这里直接改头，不看 _headers 的脸色。
    const head = new Headers(res.headers);
    head.set('Cache-Control', 'no-cache');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: head });
  }

  // ---- R2 媒体代理（图片 / 视频 / 音频） ----
  // 视频要能拖进度条就必须支持 Range：不回 206 的话浏览器只能从头顺播，一拖就重下整个文件。
  // 只在请求真的带了 Range 时才多查一次 head（拿总长度才能算出 content-range），
  // 普通图片仍是一次 get 搞定，不额外消耗 R2 请求数。
  if (seg[0] === 'media') {
    if (method !== 'GET' && method !== 'HEAD') return err('方法不允许', 405);
    // 历史数据兼容：早期上传接口回的是 /media/media/xxx（前缀重复），这里把多出来的
    // 那一段 media 归一化掉 —— 两种写法都指向同一个对象，老文章里的图也不会再是碎图。
    const rel = seg.slice(1);
    if (rel[0] === 'media') rel.shift();
    const key = MEDIA_PREFIX + rel.join('/');
    const rangeHeader = request.headers.get('range');
    const head = rangeHeader ? await env.BLOG.head(key) : null;
    if (rangeHeader && !head) return err('文件不存在', 404);
    const total = head ? head.size : 0;
    const r = rangeHeader ? parseRange(rangeHeader, total) : null;
    if (r === 'bad') {
      return new Response(null, {
        status: 416,
        headers: { 'accept-ranges': 'bytes', 'content-range': 'bytes */' + total, 'cache-control': 'no-store' },
      });
    }
    const obj = r
      ? await env.BLOG.get(key, { range: { offset: r.start, length: r.end - r.start + 1 } })
      : await env.BLOG.get(key);
    if (!obj) return err('文件不存在', 404);
    const ct = obj.httpMetadata?.contentType || obj.customMetadata?.ct || mimeOfExt(key);
    const headers = {
      'content-type': ct,
      'accept-ranges': 'bytes',
      'cache-control': 'public, max-age=31536000, immutable',
      'etag': obj.httpEtag || '',
    };
    if (r) {
      headers['content-range'] = `bytes ${r.start}-${r.end}/${total}`;
      headers['content-length'] = String(r.end - r.start + 1);
    } else if (obj.size) {
      headers['content-length'] = String(obj.size);
    }
    return new Response(method === 'HEAD' ? null : obj.body, { status: r ? 206 : 200, headers });
  }

  // ---- 主题静态资源代理（R2 themes/ 前缀；CSS 内的相对 url() 也走这里） ----
  if (seg[0] === 'theme-assets') {
    if (method !== 'GET' && method !== 'HEAD') return err('方法不允许', 405);
    const rel = seg.slice(1);
    if (!rel.length || rel.some((x) => x === '..' || x === '.' || x.includes('\\'))) return err('非法路径', 400);
    const key = 'themes/' + rel.join('/');
    const obj = await env.BLOG.get(key);
    if (obj) {
      const ct = obj.httpMetadata?.contentType || obj.customMetadata?.ct || mimeOfExt(key);
      return new Response(obj.body, {
        headers: {
          'content-type': ct,
          'cache-control': 'public, max-age=300',
          'etag': obj.httpEtag || '',
        },
      });
    }
    // 预置主题兜底（Ver 0.7 ⑥）：文件在 public/themes/<id>/，由静态资源层托管。
    // 顺序是「R2 先、预置后」—— 想改某个预置主题，上传一份同 id 的覆盖它即可，
    // 不用改仓库、也不用重新部署。地址形状仍是 /theme-assets/<id>/style.css，
    // 所以 themeLink() 与后台卡片一个字都不用改。
    if (!presets.isPreset(rel[0])) return err('资源不存在', 404);
    const assetUrl = new URL('/themes/' + rel.join('/'), url.origin).toString();
    const res = await env.ASSETS.fetch(new Request(assetUrl, { method: 'GET' }));
    if (!res || !res.ok) return err('资源不存在', 404);
    return new Response(method === 'HEAD' ? null : res.body, {
      headers: {
        'content-type': res.headers.get('content-type') || mimeOfExt(key),
        // 与 R2 主题资源同一个新鲜期：5 分钟。仓库里的文件更新后不用等 4 小时的平台默认缓存
        'cache-control': 'public, max-age=300',
      },
    });
  }

  // ---- 自定义字体文件代理（R2 fonts/ 前缀，Ver 0.6 ①） ----
  // 键名带时间戳 + 随机后缀，同一个地址的内容永不改变 —— 所以可以给一年 immutable，
  // 浏览器缓存住之后，读者第二次进文章页一个字节的字体流量都不用再花。
  // 不带 Range：字体不需要拖进度条，多一次 head 查询纯属浪费。
  if (seg[0] === 'fonts') {
    if (method !== 'GET' && method !== 'HEAD') return err('方法不允许', 405);
    const rel = seg.slice(1);
    if (!rel.length || rel.some((x) => x === '..' || x === '.' || x.includes('\\'))) return err('非法路径', 400);
    const obj = await env.BLOG.get(font.FONT_PREFIX + rel.join('/'));
    if (!obj) return err('字体文件不存在', 404);
    const ct = obj.httpMetadata?.contentType || obj.customMetadata?.ct || mimeOfExt(rel[rel.length - 1]);
    return new Response(method === 'HEAD' ? null : obj.body, {
      headers: {
        'content-type': ct,
        'cache-control': 'public, max-age=31536000, immutable',
        'etag': obj.httpEtag || '',
        // @font-face 是少数要过 CORS 的资源：将来若从另一个域名引这个字体
        // （比如主题独立部署），没有这行浏览器会直接拒绝加载。
        'access-control-allow-origin': '*',
      },
    });
  }

  // ---- robots / rss / sitemap ----
  // RSS / Sitemap 双形态：
  // - 浏览器直接打开（Accept 带 text/html 且 UA 为浏览器）→ 返回排版好的 HTML 页（rssHtml/sitemapHtml）；
  // - RSS 阅读器 / 搜索引擎 → 返回标准 XML（rssXml/sitemapXml）。
  // ?format=xml|html 可强制指定，作为逃生舱（个别抓取器若误判可用）。
  if (path === '/robots.txt') {
    return new Response(site.robotsTxt(url.origin), { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  // 动态 favicon：与页头 logo 同源（同字、同底色），底色固定品牌蓝。
  // ⚠️ 不缓存：Cloudflare 默认会给它缓存到 4 小时，改了颜色浏览器标签里还是旧的
  // （favicon 由浏览器自己拉，Ctrl+F5 也刷不掉）。cdn-cache-control 直接把 CDN 缓存关掉，
  // 站点 link 里又带了 ?v= 版本号（见 site.faviconHref），两层缓存一起破。
  if (path === '/favicon.svg') {
    const s = await db.settingsMap(env.DB);
    return new Response(site.faviconSvg(s), {
      headers: {
        'content-type': 'image/svg+xml; charset=utf-8',
        'cache-control': 'public, max-age=60',
        'cdn-cache-control': 'no-store',
      },
    });
  }
  // 判别函数见 util.wantsFeedHtml（浏览器 Accept 普遍含 application/xml，不能用它反推阅读器）
  const fmt = url.searchParams.get('format');
  const wantHtml = wantsFeedHtml(request.headers.get('accept'), request.headers.get('user-agent'), fmt);
  // Vary 必须带：否则 CDN 可能把给浏览器的 HTML 缓存后返回给阅读器。
  // 不设 max-age：Cloudflare 缓存 key 默认忽略 query，若缓存了 HTML，?format=xml 也会命中它。
  const feedHdr = (type) => ({ 'content-type': type, 'vary': 'Accept, User-Agent' });
  if (path === '/rss.xml' || path === '/feed.xml') {
    const s = await db.settingsMap(env.DB);
    if (wantHtml) return new Response(await site.rssHtml(env, s, url.origin), { headers: feedHdr('text/html; charset=utf-8') });
    return new Response(await site.rssXml(env, s, url.origin), { headers: feedHdr('application/rss+xml; charset=utf-8') });
  }
  if (path === '/sitemap.xml') {
    const s = await db.settingsMap(env.DB);
    if (wantHtml) return new Response(await site.sitemapHtml(env, s, url.origin), { headers: feedHdr('text/html; charset=utf-8') });
    return new Response(await site.sitemapXml(env, s, url.origin), { headers: feedHdr('application/xml; charset=utf-8') });
  }

  // ---- 其余全部交给前台渲染（可缓存的先走边缘缓存：命中就完全不碰 D1）----
  return serveFront(ctx, url, seg, method, path);
}

// ============ 前台页面 ============
const html = (str, status = 200) =>
  new Response(str, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });

// ---- 边缘缓存（Ver 0.5 ①）----
// 哪些前台页面能进公共缓存：它们对所有人渲染同一份 HTML。
// ⚠️ 判断的是「这条路线的输出会不会因人而异」，不是「有没有登录」：
//    - 文章页 / 独立页正文对匿名访客是同一份（「我赞过没」已改由前端补，见 public/js/site.js）
//    - 真正的例外（博主登录态、加密文章解锁态）由 cache.canCache() 在更外层拦掉
//    - 状态码非 200 的一律不缓存（404；草稿对匿名访客本来就是 404）
function sharedPath(seg) {
  // 搜索结果随 query 变化，且会把 query 铺进缓存键，不进缓存
  if ((seg[0] || '') === 'search') return false;
  // 友链跳转提醒页不进缓存（Ver 0.6 ⑨）：友链被撤下、改地址后，缓存里的旧页面
  // 还会把人往旧地址送（最长 10 分钟才后台刷新、条目留 24 小时）。这页只有一次
  // 单行查询，省这点开销不值当。
  if ((seg[0] || '') === 'jump') return false;
  // 其余前台路径（首页 / page / category|categories / tag|tags / archive / links /
  // friends / p 独立页 / 文章永久链接）输出对所有人一致，可缓存
  return true;
}

// 前台入口：匿名请求先看边缘缓存，命中直接返回，完全不碰 D1 与渲染。
// 一页能不能进公共缓存：状态 200、这条路线对所有人输出一致，
// 且渲染没主动挂 x-cache:0 否决自己（如加密文章的「密码错误」页）
const SHARED = (seg, r) => r.status === 200 && sharedPath(seg) && r.headers.get('x-cache') !== '0';

// 主题预览的参数校验（Ver 0.7 ⑥）：只认后台同一套 id 规则。
// 非法值直接当没传（不 400）—— 手工改 URL 打错一个字不该看到报错页。
function previewThemeId(v) {
  const id = String(v || '').trim().toLowerCase();
  if (!id) return '';
  if (id === 'default') return 'default';
  return /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(id) ? id : '';
}

async function serveFront(ctx, url, seg, method, path) {
  // 带 ?theme= 的请求一律不读也不写共享缓存。
  // 即便「登录态不缓存」的判据哪天出了偏差，也绝不能让「还没启用的主题」
  // 落进边缘缓存、被匿名访客看见 —— 这里再加一道与 cookie 无关的闸。
  const previewing = !!url.searchParams.get('theme');
  const anon = cache.canCache(ctx.request);
  if (anon && !previewing) {
    // render 是「重新渲染本页」的函数：缓存条目过期时用它做后台刷新。
    // 返回 null = 这一页不该缓存，read() 就不写回去。
    const hit = await cache.read(ctx, url, async () => {
      const r = await front(ctx, url, seg, method, path);
      const keep = SHARED(seg, r);
      r.headers.delete('x-cache');
      return keep ? r : null;
    });
    if (hit) return hit;
  }
  const resp = await front(ctx, url, seg, method, path);
  const vetoed = resp.headers.get('x-cache') === '0';   // 渲染自己说「别缓存我」
  const allow = SHARED(seg, resp);
  resp.headers.delete('x-cache');   // 内部标记，不外传
  if (previewing) resp.headers.set('x-robots-tag', 'noindex, nofollow');
  if (!anon || vetoed || previewing) {
    // 因人而异（登录态 / 加密文章解锁态 / 主题预览），或渲染明确要求不缓存：
    // 这一份既不能被边缘共享缓存留存，也不能让浏览器把它当公共页面存下来。
    resp.headers.set('cache-control', 'private, no-store');
  } else if (allow) {
    resp.headers.set('cache-control', 'public, max-age=0, must-revalidate');
    resp.headers.set('x-edge-cache', 'MISS');
    ctx.waitUntil(cache.save(url, resp.clone()));
  }
  return resp;
}

async function front(ctx, url, seg, method, path) {
  const { env } = ctx;
  // 没跑 0005 迁移也能用：这里自动补 type / in_nav 两列（内部有缓存，只做一次）
  await db.ensurePostCols(env.DB);
  const s = await db.settingsMap(env.DB);
  // 导航里的独立页面：按请求单独查好塞进 s（s 是本请求新建的 Map，不会串到别的请求），
  // layout() 再从 s 里取，避免用模块级全局变量导致并发请求互相覆盖。
  const navPages = await db.listPages(env.DB, { status: 'published', inNav: true });
  s.set('_nav_pages', JSON.stringify(navPages.map((p) => ({ title: p.title, slug: p.slug }))));
  // 导航里的分类：只取勾了「在导航栏显示」的顶级分类，二级分类跟随父项在下拉里出现
  const navCats = await db.navCategories(env.DB).catch(() => []);
  s.set('_nav_cats', JSON.stringify(navCats.map((c) => ({
    name: c.name, slug: c.slug, full_slug: c.full_slug,
    children: (c.children || []).map((k) => ({ name: k.name, slug: k.slug, full_slug: k.full_slug })),
  }))));
  // 侧边栏（Ver 0.5 ②）：没开就立刻返回空串、一次库都不查；开了才按勾选项查。
  // HTML 塞进 s（本请求新建的 Map），layout() 再取出来拼两列，并发请求互不干扰。
  s.set('_sidebar_html', await buildSidebar(env, s, ctx).catch(() => ''));
  const per = Math.min(20, Math.max(1, parseInt(s.get('per_page'), 10) || 8));
  const user = await userFromRequest(env, ctx.request);
  // ---- 主题预览（Ver 0.7 ⑥）：前台任意页面加 ?theme=<id> ----
  // 只有博主登录态才认。两条理由缺一不可：
  //   ① 否则任何人都能把「还没启用」的主题套到你的站上试穿；
  //   ② 预览页绝不能进边缘缓存（serveFront 已按 query 硬拦了一道，这里再按身份拦）。
  // 只改本请求的 settings Map（每请求新建），不写库，不动任何人的 active_theme。
  // 存在性用 head() 核实：id 合法但主题已被删时不覆盖，页面照旧显示当前主题。
  const pvId = previewThemeId(url.searchParams.get('theme'));
  if (pvId && user) {
    const exists = pvId === 'default' || presets.isPreset(pvId)
      || (env.BLOG && await env.BLOG.head('themes/' + pvId + '/style.css'));
    if (exists) {
      s.set('active_theme', pvId);
      // 预览条要显示中文名：预置主题的元信息在 presets.js，别的主题读 theme.json，
      // 都拿不到就退回 id（横幅不该因为元数据损坏而消失，否则人分不清预览与线上）
      let pvName = pvId === 'default' ? '系统默认' : '';
      if (!pvName && presets.isPreset(pvId)) {
        const t = presets.LIST.find((x) => x.id === pvId);
        if (t) pvName = t.name;
      }
      if (!pvName) {
        try {
          const mj = env.BLOG && await env.BLOG.get('themes/' + pvId + '/theme.json');
          if (mj) { const j = await mj.json(); if (j && j.name) pvName = String(j.name).slice(0, 60); }
        } catch (e) { pvName = ''; }
      }
      s.set('_preview_theme', pvId);
      s.set('_preview_name', pvName || pvId);
    }
  }
  const pageNum = (p) => Math.max(1, parseInt(p, 10) || 1);

  // 首页 / /page/n
  if (seg.length === 0 || (seg.length === 2 && seg[0] === 'page')) {
    const page = seg.length === 2 ? pageNum(seg[1]) : 1;
    const data = await db.listPosts(env.DB, { status: 'published', page, per });
    data.categories = await db.listCategories(env.DB);
    return html(site.renderHome(s, data, page));
  }

  // 分类 /category · /category/别名 · /category/父别名/子别名（后两者可再跟 /page/n）
  if (seg[0] === 'category') {
    const cats = await db.listCategories(env.DB);
    if (!seg[1]) {
      // 全部分类：按父子重排，二级分类排在上级之后
      const cards = db.treeCategories(cats).map((c) => `<div class="cat-card${c.parent_id ? ' cat-card-sub' : ''}">
        <h3><a href="${esc(catUrl(c))}">${c.parent_id ? '<i class="sub-mark">└</i>' : ''}${esc(c.name)}</a></h3>
        ${c.description ? `<p>${esc(c.description)}</p>` : ''}<span class="cnt">${c.count || 0} 篇文章</span></div>`).join('');
      return html(site.renderListPage(s, { head: '全部分类', active: 'cat', title: '分类',
        itemsHtml: '', empty: '还没有分类', extra: cards ? `<div class="cat-grid">${cards}</div>` : '' }));
    }
    // 先摘掉尾部的 /page/n，剩下的都是分类路径段
    let page = 1;
    const parts = [];
    for (let i = 1; i < seg.length; i++) {
      if (seg[i] === 'page') { page = pageNum(seg[i + 1]); break; }
      parts.push(seg[i]);
    }
    // 别名全站唯一，用最后一段就能定位到分类
    const cat = cats.find((c) => c.slug === (parts[parts.length - 1] || ''));
    if (!cat) return html(site.render404(s), 404);
    // 层级不对就 301：父分类改了别名、子分类被当顶级访问、顶级分类多写了一层，全都跳到规范地址
    const want = catUrl(cat);
    if ('/category/' + parts.join('/') !== want) return redirect301(want + (page > 1 ? `/page/${page}` : ''));
    const data = await db.listPosts(env.DB, { status: 'published', cat: cat.slug, page, per });
    const itemsHtml = data.items.map((p) => {
      const u = esc(postUrl(s, p));   // 永久链接：随「文章设置」里的规则变化
      const cover = p.cover_key ? `<div class="pc-cover"><a href="${u}"><img src="/media/${esc(p.cover_key)}" alt="" loading="lazy"></a></div>` : '';
      const tags = (p.tags || []).map((t) => `<a class="tag-chip" href="/tag/${esc(t.slug)}">${esc(t.name)}</a>`).join('');
      const ex = site.excerptOf(p);
      return `<article class="pc${cover ? '' : ' no-cover'}"><div>
        <div class="pc-meta"><time>${esc(p.published_at || '').slice(0, 10)}</time><span class="dot">·</span><span>阅读 ${p.view_count || 0}</span></div>
        <h2 class="pc-title">${site.pinBadge(p)}<a href="${u}">${esc(p.title)}</a></h2>
        ${p.locked ? '<p class="pc-excerpt lock-note">本文已加密，需输入密码访问</p>'
    : (ex ? `<p class="pc-excerpt">${esc(ex)}</p>` : '')}
        ${tags ? `<div class="pc-tags">${tags}</div>` : ''}</div>${cover}</article>`;
    }).join('');
    // 顶级分类页顶上列出它的二级分类入口；二级分类页则给出返回上级的链接
    const kids = cats.filter((c) => c.parent_id === cat.id);
    const subNav = kids.length
      ? `<div class="chips">${kids.map((c) => `<a class="chip chip-sub" href="${esc(catUrl(c))}"><i class="sub-mark">└</i>${esc(c.name)}<b> ${c.count || 0}</b></a>`).join('')}</div>`
      : (cat.parent_id ? `<p class="desc">上级分类：<a href="/category/${esc(cat.parent_slug)}">${esc(cat.parent_name || cat.parent_slug)}</a></p>` : '');
    const headName = cat.parent_id ? `${cat.parent_name || cat.parent_slug} / ${cat.name}` : cat.name;
    const makeUrl = (n) => (n <= 1 ? want : `${want}/page/${n}`);
    return html(site.renderListPage(s, {
      // active 用 c:<别名>：导航里对应的分类项（含二级）才能高亮
      head: `分类：${headName}`, active: 'c:' + cat.slug, title: cat.name,
      desc: cat.description || '', extra: subNav,
      itemsHtml, empty: '该分类下暂无文章', page, pages: data.pages, makeUrl,
    }));
  }

  // 标签 /tag /tag/x[/page/n]
  if (seg[0] === 'tag') {
    if (!seg[1]) {
      const tags = await db.listTags(env.DB);
      const cloud = tags.map((t) => `<a class="tag-pill" href="/tag/${esc(t.slug)}">${esc(t.name)}<b> ${t.count || 0}</b></a>`).join('');
      return html(site.renderListPage(s, { head: '全部标签', active: 'tags', title: '标签',
        itemsHtml: '', empty: '还没有标签', extra: `<div class="tags-cloud">${cloud}</div>` }));
    }
    const slug = seg[1];
    let page = 1;
    if (seg[2] === 'page' && seg[3]) page = pageNum(seg[3]);
    const tags = await db.listTags(env.DB);
    const tag = tags.find((t) => t.slug === slug);
    if (!tag) return html(site.render404(s), 404);
    const data = await db.listPosts(env.DB, { status: 'published', tag: slug, page, per });
    const itemsHtml = data.items.map((p) => `<article class="pc no-cover"><div>
      <div class="pc-meta"><time>${esc(p.published_at || '').slice(0, 10)}</time><span class="dot">·</span><span>${p.view_count || 0} 阅读</span></div>
      <h2 class="pc-title">${site.pinBadge(p)}<a href="${esc(postUrl(s, p))}">${esc(p.title)}</a></h2></div></article>`).join('');
    const makeUrl = (n) => (n <= 1 ? `/tag/${slug}` : `/tag/${slug}/page/${n}`);
    return html(site.renderListPage(s, {
      head: `标签：${tag.name}`, active: 'tags', title: tag.name, desc: `共 ${data.total} 篇相关文章`,
      itemsHtml, empty: '该标签下暂无文章', page, pages: data.pages, makeUrl,
    }));
  }

  // 归档（Ver 0.4 ⑭）：默认按年份分组，?view=month 换成按月份
  if (seg[0] === 'archive' && seg.length === 1) {
    const view = url.searchParams.get('view') === 'month' ? 'month' : 'year';
    const DB = env.DB;
    // 统计 / 分类 / 标签都是锦上添花：任何一项查挂了最多少块内容，不能让整个归档页 500
    const [posts, stats, cats, tags] = await Promise.all([
      db.archivePosts(DB),
      db.archiveStats(DB).catch(() => ({})),
      db.listCategories(DB).catch(() => []),
      db.listTags(DB).catch(() => []),
    ]);
    return html(site.renderArchive(s, { posts, stats, cats, tags, view }));
  }

  // 友情链接 /links：已通过的友链 + 读者申请表单
  if (seg[0] === 'links' && seg.length === 1) {
    // 建表失败（极端情况）也不能让页面 500，退化成空列表
    const links = await db.listLinks(env.DB, { status: 'approved' }).catch(() => []);
    return html(site.renderLinks(s, { links, captcha: s.get('captcha') !== '0' }));
  }

  // 外链中转提醒页 /jump?u=<b64url>&s=<hmac>（Ver 0.6 ⑪）
  // 正文 / 评论昵称 / 友圈标题三处的外链都走这里。★ 必须验签：没有 s 或 s 不对一律
  // 400 —— 否则 /jump?u=<任意地址> 立刻变成开放重定向，谁都能拿本站域名当跳板。
  // 签名只证明「这条地址是本站生成的」，不证明对方站点安全，所以页面照旧显示
  // 目标域名 + 免责说明，并给满 5 秒。
  if (seg[0] === 'jump' && seg.length === 1) {
    const tk = url.searchParams.get('u') || '';
    const sig = url.searchParams.get('s') || '';
    let target = '';
    try { target = jump.safeJumpUrl(jump.unb64url(tk)); } catch (e) { target = ''; }
    if (!target || !(await jump.verifyToken(tk, sig, env.AUTH_SECRET))) {
      const bad = html(site.renderJumpBad(s), 400);
      bad.headers.set('cache-control', 'no-store');
      return bad;
    }
    // 正文里偶尔会写死本站的完整地址：别绕一圈提醒页，直接回去。
    // 不用 Response.redirect（它的响应头是只读的，serveFront 后面还要删内部标记）
    try {
      if (new URL(target).host === url.host) {
        return new Response(null, { status: 302, headers: { location: target } });
      }
    } catch (e) { /* 忽略：URL 解析失败就按普通外链处理 */ }
    s.set('_sidebar_html', '');
    let host = '';
    try { host = new URL(target).host; } catch (e) { host = ''; }
    const r = html(site.renderJump(s, { url: target, name: host, kind: 'out' }));
    r.headers.set('cache-control', 'no-store');
    return r;
  }

  // 友链跳转提醒页 /jump/<id>（Ver 0.6 ⑨）：说明去哪 + 免责说明，5 秒后自动跳。
  // ★★ 目标地址只从 links 表按 id 现查，**绝不接受 URL 参数** —— 否则这个路由就成了
  //    开放重定向：任何人都能拿本站域名当跳板去钓鱼（`/jump?url=诈骗站`）。
  //    因此卡片里挂的是 links.id，查不到 / 未通过 / 已撤下的友链一律 404，与前台
  //    「只展示已通过」的口径完全一致。
  // ★ 顺带把伪协议兜底挡住：后台手填或历史数据里若有 javascript: 之类的地址，
  //    它会被原样写进跳转页的 <a href> 与 location.replace。
  if (seg[0] === 'jump' && seg.length === 2 && /^\d+$/.test(seg[1])) {
    const lk = await db.getLink(env.DB, parseInt(seg[1], 10)).catch(() => null);
    const okUrl = /^https?:\/\/[^\s]+$/i.test(String((lk && lk.url) || ''));
    if (!lk || lk.status !== 'approved' || !okUrl) return html(site.render404(s), 404);
    // 中转页只有 5 秒寿命，侧边栏（热门文章 / 最新评论 / 搜索框）在这儿纯属干扰，
    // 顺手关掉：省一次侧边栏子查询，也让页面只有「去哪 + 免责 + 立即前往」。
    s.set('_sidebar_html', '');
    return html(site.renderJump(s, { link: lk }));
  }

  // 友圈 /friends（Ver 0.4 ⑫）：把订阅的别人家的文章按发布时间倒序展示
  if (seg[0] === 'friends'
    && (seg.length === 1 || (seg.length === 3 && seg[1] === 'page' && /^\d+$/.test(seg[2])))) {
    const dbx = env.DB;
    const page = seg.length === 3 ? Math.max(1, parseInt(seg[2], 10) || 1) : 1;
    const [total, feeds] = await Promise.all([
      db.countFriendPosts(dbx).catch(() => 0),
      db.listFeeds(dbx, { enabledOnly: true }).catch(() => []),
    ]);
    const posts = await db.listFriendPosts(dbx, {
      limit: FRIEND_PER_PAGE, offset: (page - 1) * FRIEND_PER_PAGE,
    }).catch(() => []);
    // 数据过期就在后台补一轮，本次渲染不等它：抓取再慢也不该让访客干等
    const lastAt = await db.getSetting(dbx, 'friends_refresh_at', '').catch(() => '');
    if (feeds.length && feed.feedStale(lastAt, FRIEND_TTL_MIN)) {
      ctx.waitUntil(feed.refreshFeeds(env, { limit: 3 }).catch(() => {}));
    }
    return html(site.renderFriends(s, {
      posts, feeds, total, page,
      pages: Math.max(1, Math.ceil(total / FRIEND_PER_PAGE)),
    }));
  }

  // 分类总览 /categories、标签总览 /tags（导航栏指向这两个地址，此前缺失导致 404）
  if ((seg[0] === 'categories' || seg[0] === 'tags') && seg.length === 1) {
    const isCat = seg[0] === 'categories';
    const list = isCat ? await db.listCategories(env.DB) : await db.listTags(env.DB);
    return html(isCat ? site.renderCategories(s, list) : site.renderTags(s, list));
  }

  // 搜索（只有一页：取前 20 条，没有 /search/page/n 路由，所以不传 pages，
  // 分页条会自动不渲染——以前这里传了个返回空串的 makeUrl，反而渲染出一个点不动的空分页条）
  if (seg[0] === 'search' && seg.length === 1) {
    const q = (url.searchParams.get('q') || '').trim().slice(0, 60);
    let itemsHtml = '', total = 0;
    if (q) {
      const data = await db.listPosts(env.DB, { status: 'published', q, per: 20 });
      total = data.total;
      itemsHtml = data.items.map((p) => `<article class="pc no-cover"><div>
        <div class="pc-meta"><time>${esc(p.published_at || '').slice(0, 10)}</time><span class="dot">·</span><span>${p.view_count || 0} 阅读</span></div>
        <h2 class="pc-title">${site.pinBadge(p)}${p.locked ? '<span class="lock-mark">🔒</span>' : ''}<a href="${esc(postUrl(s, p))}">${esc(p.title)}</a></h2>
        ${p.locked ? '<p class="pc-excerpt lock-note">本文已加密，需输入密码访问</p>'
    : (site.excerptOf(p) ? `<p class="pc-excerpt">${esc(site.excerptOf(p))}</p>` : '')}</div></article>`).join('');
    }
    return html(site.renderListPage(s, {
      head: q ? `“${esc(q)}” 的搜索结果` : '搜索', active: '', title: '搜索', q,
      desc: q ? `共找到 ${total} 篇文章` : '输入关键词搜索文章标题与摘要',
      itemsHtml, empty: q ? '没有找到相关文章' : '请输入搜索词',
    }));
  }

  // 独立页面 /p/<slug>（Ver 0.4）：固定前缀，永不与文章永久链接抢路径
  if (seg[0] === 'p' && seg.length === 2) {
    const pg = await db.getPost(env.DB, { slug: seg[1] });
    if (!pg || pg.type !== 'page') return html(site.render404(s), 404);
    if (pg.status !== 'published' && !user) return html(site.render404(s), 404);
    if (pg.status !== 'published') {
      pg.content_html = `<div class="empty" style="padding:14px;margin-bottom:14px">此页面为<b>草稿</b>，仅你可见 · <a href="/admin#/pages/${pg.id}">回后台编辑</a></div>` + pg.content_html;
    }
    return html(site.renderPage(s, pg));
  }

  // 文章页：按「永久链接」规则解析（放在所有固定路由之后，保证 /archive、/search 等
  // 系统路径永远优先；命中不了再兜底旧地址 /post/:slug(.html) 并 301 到当前规范地址）
  // 传 request：加密文章要读表单密码、读解锁 Cookie
  const pr = await permalinkRoute(env, s, path, user, url.origin, ctx.request, method);
  if (pr) return pr;

  // 404
  return html(site.render404(s), 404);
}

// ============ 永久链接（伪静态）解析 ============
const redirect301 = (loc) => new Response(null, {
  status: 301, headers: { location: loc, 'cache-control': 'no-store' },
});
// 路径可能是百分号编码（中文别名）；解码失败就按原样匹配，不能让异常变成 500
const safeDecode = (p) => { try { return decodeURIComponent(p); } catch (e) { return p; } };

async function permalinkRoute(env, s, path, user, origin, request, method) {
  const p0 = safeDecode(path);
  const { re, keys } = permalinkRegex(permalinkOf(s));
  const m = re.exec(p0);
  let post = null;
  if (m) {
    const kv = {};
    keys.forEach((k, i) => { kv[k] = m[i + 1]; });
    post = kv.slug
      ? await db.getPost(env.DB, { slug: kv.slug })
      : (kv.id ? await db.getPost(env.DB, { id: Number(kv.id) }) : null);
    // 页面不当文章渲染：规则恰好匹配到页面别名时（如 /{slug}），统一跳到 /p/<slug>，
    // 否则「关于我」会顶着发布时间、分类和评论区出现，看着就是一篇没归类的文章。
    if (post && post.type === 'page') return redirect301(pageUrl(post));
    // 文章改过发布时间或分类后，URL 里的日期/分类就对不上了 → 301 到当前规范地址
    if (post && !permalinkVarsMatch(kv, post)) return redirect301(postUrl(s, post));
  }
  if (!post) {
    // 旧地址 /post/xxx 与 /post/xxx.html 始终可用：改了规则后老链接不会 404
    const lm = /^\/post\/(.+?)(?:\.html)?$/.exec(p0);
    if (lm) {
      const old = await db.getPost(env.DB, { slug: lm[1] });
      if (old) return redirect301(old.type === 'page' ? pageUrl(old) : postUrl(s, old));
    }
    return null;
  }
  if (post.status !== 'published' && !user) return html(site.render404(s), 404);
  if (post.status !== 'published') {
    post.content_html = `<div class="empty" style="padding:14px;margin-bottom:14px">此文章为<b>草稿</b>，仅你可见 · <a href="/admin#/posts/${post.id}">回后台编辑</a></div>` + post.content_html;
  }
  // ---------- 加密文章（Ver 0.4 ④）----------
  // 博主本人免密；访客要输密码，输对了写 Cookie，之后同浏览器直接放行。
  // Cookie 里只存密码的 SHA-256，不下发明文。
  if (String(post.password || '') && !user) {
    const okHash = await sha256Hex(post.password);
    const ck = readCookie(request, postPassCookie(post.id));
    if (!(ck && safeEqual(ck, okHash))) {
      if (method === 'POST') {
        const form = await request.formData().catch(() => null);
        const pw = String((form && form.get('post_password')) || '');
        if (pw && safeEqual(await sha256Hex(pw), okHash)) {
          const r = new Response(null, { status: 303, headers: { location: postUrl(s, post) } });
          r.headers.set('set-cookie',
            `${postPassCookie(post.id)}=${okHash}; Path=/; Max-Age=15552000; HttpOnly; SameSite=Lax`);
          return r;
        }
        // 「密码错误」只对当前这位访客有意义，不进公共缓存
        const bad = html(site.renderLocked(s, post, true));
        bad.headers.set('x-cache', '0');
        return bad;
      }
      return html(site.renderLocked(s, post, false));
    }
  }
  const [siblings, comments, cfg, likeN] = await Promise.all([
    db.siblings(env.DB, post),
    db.commentsForPost(env.DB, post.id),
    Promise.resolve({
      allow: s.get('allow_comments') === '1',
      audit: s.get('comment_audit') === '1',
      captcha: s.get('captcha') !== '0',   // 未设置即默认开启
    }),
    // 只取「全站赞数」，不再按访客取「我赞过没」：
    // 文章页 HTML 必须对所有人一致才能进边缘缓存，那部分改由前端加载后请求 /api/like 补上。
    db.likeState(env.DB, post.id, '').catch(() => null),
  ]);
  if (likeN) post.likes = likeN.likes;
  return html(site.renderArticle(s, post, { siblings, comments, cfg, origin }));
}

// ============ API ============
async function api(ctx, url, seg, method) {
  const { env, request } = ctx;
  const dbx = env.DB;
  const authUser = async () => userFromRequest(env, request);

  // ---- 内容更新后清边缘缓存（Ver 0.5 ① B 部分）----
  // 一律 waitUntil 异步做：清理失败绝不能影响「文章到底有没有写进去」这个结果。
  // 没配 CF_ZONE_ID / CF_API_TOKEN 时全是空操作（页面靠 10 分钟新鲜期自然更新）。
  const abs = (p) => new URL(p, url.origin).toString();
  const clearPaths = (paths) => {
    if (!purge.ready(env)) return;
    ctx.waitUntil(purge.urls(env, [...new Set(paths.filter(Boolean).map(abs))]).catch(() => {}));
  };
  const clearAll = () => {
    if (!purge.ready(env)) return;
    ctx.waitUntil(purge.all(env).catch(() => {}));
  };
  // 文章改动影响：首页 / 列表页 / 归档 / 订阅 / 站点地图 / 它自己的地址 / 所属分类与标签
  const clearForPost = (p, sm) => {
    if (!purge.ready(env) || !p) return;
    if (p.type === 'page') { clearAll(); return; }   // 独立页面可能出现在导航里 → 每页页头都变了
    const paths = ['/', '/archive', '/archive?view=month', '/rss.xml', '/feed.xml', '/sitemap.xml',
      '/categories', '/tags', '/category', postUrl(sm, p)];
    if (p.category && p.category.full_slug) paths.push(catUrl(p.category));
    for (const tg of (p.tags || [])) if (tg && tg.slug) paths.push('/tag/' + tg.slug);
    clearPaths(paths);
  };
  // 评论一变，受影响的是它所属的那篇文章页
  const clearForComment = async (cid) => {
    if (!purge.ready(env)) return;
    try {
      const c = await db.getComment(dbx, cid);
      if (!c) return;
      const p = await db.getPost(dbx, { id: c.post_id });
      if (p && p.type !== 'page') clearPaths([postUrl(await db.settingsMap(dbx), p)]);
    } catch (e) { /* 清缓存失败不影响评论处理本身 */ }
  };

  // ---- 搜索引擎推送（Ver 0.8 ①）----
  // 只在「文章」「已发布」「没加密」时推：
  //   - 独立页面不进搜索列表，推了只是浪费配额；
  //   - 加密文章的正文对搜索引擎是锁着的，收录一个打不开的地址没有意义。
  // 同一地址 10 分钟内只推一次：编辑器带自动保存，每敲几个字就推会把每日配额刷掉。
  const SEO_THROTTLE_MS = 10 * 60 * 1000;
  const seoPush = (p, sm) => {
    if (!p || p.type === 'page' || p.status !== 'published' || p.password) return;
    const cfg = seo.config(sm, url.origin);
    if (!cfg.on || (!cfg.baidu && !cfg.indexnow)) return;
    const target = cfg.base.replace(/\/+$/, '') + postUrl(sm, p);
    ctx.waitUntil((async () => {
      try {
        const prev = JSON.parse((await db.settingsMap(dbx)).get('_seo_last') || '{}');
        if (prev.url === target && prev.ok && Date.now() - (prev.ts || 0) < SEO_THROTTLE_MS) return;
      } catch (e) { /* 旧状态坏了就当从没推过 */ }
      const r = await seo.push(cfg, [target]);
      if (!r) return;
      // 存一份给设置页显示：开了没效果时，这里能直接看出是哪一家、报了什么
      await db.setSetting(dbx, '_seo_last', JSON.stringify({ ...r, url: target, time: bnNow() }));
    })().catch(() => {}));
  };

  // ---- IP 归属地（Ver 0.5 ⑦）----
  // 开关默认开（与验证码同一套写法：只有明确存了 '0' 才算关），接口默认百度。
  const geoOn = async () => (await db.getSetting(dbx, 'ipgeo_on')) !== '0';
  const geoProvider = async () => ipgeo.pickProvider(await db.getSetting(dbx, 'ipgeo_src'));
  // 评论落库后异步补归属地。必须异步：第三方接口往返 200ms~5s，
  // 不能让读者点完「发表评论」在那儿干等。
  // 查完若有结果，再清一次这篇文章页 —— 评论落库那一步已经清过一次，
  // 但那时归属地还没查到，不清的话前台要等最长 10 分钟才显示得出来。
  const asyncGeo = (ips, pagePath) => {
    ctx.waitUntil((async () => {
      try {
        if (!(await geoOn())) return;
        const r = await ipgeo.geoSync(dbx, ips, await geoProvider(), { timeout: 4000 });
        if (r.checked && pagePath && purge.ready(env)) clearPaths([pagePath]);
      } catch (e) { /* 归属地是锦上添花：出任何问题都不能影响评论本身 */ }
    })());
  };

  // --- 安装状态（公开） ---
  if (seg[0] === 'state' && method === 'GET' && seg.length === 1) {
    const installed = await db.isInstalled(dbx);
    const u = await authUser();
    return json({ installed, authed: !!u, username: u });
  }

  // --- 初始化向导（公开，仅未安装时） ---
  if (seg[0] === 'setup' && method === 'POST' && seg.length === 1) {
    if (await db.isInstalled(dbx)) return err('系统已初始化，如需重置请直接修改数据库', 403);
    const b = (await readJson(request)) || {};
    const username = String(b.username || '').trim();
    const password = String(b.password || '');
    if (!/^[A-Za-z0-9_]{3,32}$/.test(username)) return err('用户名需为 3–32 位字母、数字或下划线');
    if (password.length < 6) return err('密码至少 6 位');
    // 邮箱选填：只校验格式，不验证是否真实存在。注意先校验完整串再截断，
    // 反过来（先截断）会把长地址截成一串 a 再判为非法
    const emailRaw = String(b.email || '').trim();
    if (emailRaw && !isEmail(emailRaw)) return err('邮箱格式不正确（示例：name@example.com）');
    const email = emailRaw.slice(0, 120);
    const salt = newSalt();
    const hash = await pbkdf2(password, salt);
    await db.setSetting(dbx, 'site_title', String(b.site_title || '').trim().slice(0, 60) || '我的博客');
    if (b.site_subtitle != null) await db.setSetting(dbx, 'site_subtitle', String(b.site_subtitle).slice(0, 80));
    if (b.author_name != null) await db.setSetting(dbx, 'author_name', String(b.author_name).slice(0, 30));
    if (b.accent && isHexColor(String(b.accent))) await db.setSetting(dbx, 'accent', b.accent);
    if (email) await db.setSetting(dbx, 'email', email);
    await db.setSetting(dbx, 'admin_username', username);
    await db.setSetting(dbx, 'admin_pass_salt', salt);
    await db.setSetting(dbx, 'admin_pass_hash', hash);
    await db.setSetting(dbx, 'admin_pass_iter', String(100000));
    const value = await makeSessionValue(env, username);
    return jset({ ok: true }, setSessionCookie(value));
  }

  // --- 登录 / 登出 / 当前用户（登出公开即可） ---
  if (seg[0] === 'auth' && seg[1]) {
    if (seg[1] === 'login' && method === 'POST' && seg.length === 2) {
      const b = (await readJson(request)) || {};
      const uname = String(b.username || '').trim();
      const u2 = await db.getSetting(dbx, 'admin_username');
      if (!u2 || u2 !== uname) return err('用户名或密码错误', 401);
      const salt = await db.getSetting(dbx, 'admin_pass_salt');
      const hash = await db.getSetting(dbx, 'admin_pass_hash');
      const iter = parseInt(await db.getSetting(dbx, 'admin_pass_iter'), 10) || 100000;
      if ((await pbkdf2(String(b.password || ''), salt, iter)) !== hash) return err('用户名或密码错误', 401);
      const value = await makeSessionValue(env, uname);
      return jset({ ok: true, username: uname }, setSessionCookie(value));
    }
    if (seg[1] === 'logout' && method === 'POST') return jset({ ok: true }, clearSessionCookie());
    if (seg[1] === 'me' && method === 'GET') {
      const u = await authUser();
      if (!u) return err('未登录', 401);
      return json({ username: u });
    }
    return err('接口不存在', 404);
  }

  // --- 算术验证码图片（公开）：下发 SVG，同时把签名后的答案写入 HttpOnly Cookie ---
  if (seg[0] === 'captcha' && method === 'GET' && seg.length === 1) {
    const cap = await newCaptcha(env);
    return new Response(cap.svg, {
      status: 200,
      headers: {
        'content-type': 'image/svg+xml; charset=utf-8',
        'cache-control': 'no-store, no-cache, must-revalidate',
        'content-security-policy': "default-src 'none'",
        'set-cookie': cap.cookie,
      },
    });
  }

  // --- 阅读量（公开） ---
  if (seg[0] === 'view' && method === 'POST' && seg.length === 1) {
    const b = (await readJson(request)) || {};
    if (b.slug) await db.incView(dbx, String(b.slug).slice(0, 120));
    return json({ ok: true });
  }

  // --- 读取点赞状态（公开，只读）---
  // 文章页 HTML 现在要进边缘缓存（对所有人同一份），所以「我赞过没」不能按 Cookie 在服务端回填，
  // 改由页面加载后由前端补一次。只读、不下发 Cookie、不写库，因此不必过 hitGuard。
  if (seg[0] === 'like' && method === 'GET' && seg.length === 1) {
    const id = parseInt(url.searchParams.get('id'), 10);
    if (!id) return err('缺少文章 id', 400);
    const vid = readCookie(request, 'blog_vid');
    const st = await db.likeState(dbx, id, vid ? String(vid).slice(0, 40) : '').catch(() => null);
    return json(st || { likes: 0, liked: false });
  }

  // --- 文章点赞（公开） ---
  // 同一访客（blog_vid）对同一篇文章只能赞一次，再点一次是取消，所以天然不需要额外限频。
  // 加密文章与独立页面不给赞：前者连正文都看不到，后者没有「文章」的互动属性。
  if (seg[0] === 'like' && method === 'POST' && seg.length === 1) {
    if (hitGuard(request)) return json({ ok: true, ignored: true }); // 蜘蛛 / 脚本请求：不写库、不下发 Cookie
    const b = (await readJson(request)) || {};
    let post = null;
    const id = parseInt(b.id, 10);
    if (id) post = await db.getPost(dbx, { id });
    else if (b.slug) post = await db.getPost(dbx, { slug: String(b.slug).slice(0, 120) });
    if (!post || post.status !== 'published' || post.type === 'page') return err('文章不存在', 404);
    if (post.locked) return err('加密文章不支持点赞', 403);
    let vid = readCookie(request, 'blog_vid');
    let cookie = '';
    if (!vid) {
      vid = newVisitorId();
      cookie = `blog_vid=${vid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`;
    }
    let st = { likes: 0, liked: false };
    try {
      st = await db.toggleLike(dbx, post.id, String(vid).slice(0, 40));
    } catch (e) {
      console.error('like error:', e);
      return err('点赞失败，请稍后再试', 500);
    }
    return jset({ ok: true, likes: st.likes, liked: st.liked }, cookie);
  }

  // --- 站点访问上报（公开）：全站 PV / UV，按天聚合 ---
  // 与 /api/view 的区别：view 只统计文章阅读量（每篇独立，用于热门文章），
  // hit 统计整站页面浏览（首页、分类、标签、归档、搜索、文章页都算），刷新也计一次 PV。
  if (seg[0] === 'hit' && method === 'POST' && seg.length === 1) {
    // 先过防刷：蜘蛛与脚本请求直接放行返回，不写库、也不下发 Cookie（省掉全部 D1 写入）
    if (hitGuard(request)) return json({ ok: true });
    const day = bnNow().slice(0, 10);
    let vid = readCookie(request, 'blog_vid');
    let cookie = '';
    if (!vid) {
      vid = newVisitorId();
      // 首次访问才下发；HttpOnly 防 JS 读取，1 年后自动失效
      cookie = `blog_vid=${vid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`;
    }
    try {
      await db.recordHit(dbx, day, String(vid).slice(0, 40));
    } catch (e) {
      // 统计挂了也不能影响正常浏览：静默忽略
      console.error('pv error:', e);
    }
    return jset({ ok: true }, cookie);
  }

  // --- 读者提交评论（公开） ---
  if (seg[0] === 'comments' && method === 'POST' && seg.length === 1) {
    const b = (await readJson(request)) || {};
    const slug = String(b.slug || '').slice(0, 120);
    const post = await db.getPost(dbx, { slug });
    if (!post || post.status !== 'published') return err('文章不存在', 404);
    if ((await db.getSetting(dbx, 'allow_comments')) !== '1') return err('评论功能已关闭', 403);
    if (b.company) return json({ ok: true, pending: false }); // 蜜罐命中：静默放行
    const author = String(b.author || '').trim().slice(0, 40);
    const email = String(b.email || '').trim().slice(0, 120);
    const website = String(b.website || '').trim().slice(0, 200);
    const content = String(b.content || '').trim();
    if (!author) return err('请填写昵称');
    if (content.length < 3 || content.length > 2000) return err('评论内容需在 3–2000 字之间');
    // 邮箱必填：用于生成 Gravatar 头像（仅存 MD5 后的头像地址，不公开邮箱原文）
    if (!email) return err('请填写邮箱（用于显示头像，不会公开）');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return err('邮箱格式不正确');
    if (website && !/^https?:\/\/[^\s]+$/i.test(website)) return err('网址需以 http:// 或 https:// 开头');
    // 算术验证码：默认开启（设置项缺失即视为开启），答错/过期都拒绝
    const capOn = (await db.getSetting(dbx, 'captcha')) !== '0';
    if (capOn && !(await checkCaptcha(env, request, b.captcha))) {
      return err('验证码不正确或已过期，请点击图片换一张');
    }
    const ip = request.headers.get('CF-Connecting-IP') || '';
    if ((await db.recentCommentsByIp(dbx, ip, 60)) >= 5) return err('评论过于频繁，请稍后再试', 429);
    const audit = (await db.getSetting(dbx, 'comment_audit')) === '1';
    await db.addComment(dbx, {
      postId: post.id, author, email, website, content,
      status: audit ? 'pending' : 'approved', isAdmin: 0, ip,
    });
    const cmtPath = postUrl(await db.settingsMap(dbx), post);
    // 免审评论会立刻出现在文章页上：把那一页的缓存清掉，别让读者刚发的评论「看不见」
    if (!audit && purge.ready(env)) clearPaths([cmtPath]);
    // 归属地异步补，查完再清一次（评论落库时归属地还没查到，见 asyncGeo 注释）
    asyncGeo([ip], cmtPath);
    // 邮件通知异步发：SMTP 握手可能要 1–3 秒，不能拖慢读者提交评论的响应
    ctx.waitUntil(notifyNewComment(dbx, url.origin, post, { author, email, content, status: audit ? 'pending' : 'approved' }));
    // 验证码一次性：用掉即作废（前端随后会自动换一张新图）
    return capOn ? jset({ ok: true, pending: audit }, clearCaptchaCookie()) : json({ ok: true, pending: audit });
  }

  // --- 读者申请友链（公开） ---
  // 与评论同一套防刷：蜜罐 + 算术验证码 + 同 IP 频控；进来一律 pending，前台不展示。
  if (seg[0] === 'link-apply' && method === 'POST' && seg.length === 1) {
    const b = (await readJson(request)) || {};
    if (b.company) return json({ ok: true }); // 蜜罐命中：静默放行，不让机器人察觉
    const name = String(b.name || '').trim().slice(0, 40);
    const url = String(b.url || '').trim().slice(0, 300);
    const description = String(b.description || '').trim().slice(0, 120);
    const logo = String(b.logo || '').trim().slice(0, 300);
    const contact = String(b.contact || '').trim().slice(0, 80);
    const reason = String(b.reason || '').trim().slice(0, 300);
    if (!name) return err('请填写站点名称');
    if (!url) return err('请填写站点地址');
    // 只放行 http(s)：这些地址会原样写进 <a href>，必须挡掉 javascript: 等伪协议
    if (!/^https?:\/\/[^\s]+$/i.test(url)) return err('网址需以 http:// 或 https:// 开头');
    if (logo && !/^https?:\/\/[^\s]+$/i.test(logo)) return err('图标地址需以 http:// 或 https:// 开头');
    const capOn = (await db.getSetting(dbx, 'captcha')) !== '0';
    if (capOn && !(await checkCaptcha(env, request, b.captcha))) {
      return err('验证码不正确或已过期，请点击图片换一张');
    }
    const ip = request.headers.get('CF-Connecting-IP') || '';
    if ((await db.recentLinkApplies(dbx, ip, 3600)) >= 3) return err('申请过于频繁，请稍后再试', 429);
    // 同网址去重（忽略末尾斜杠）：已在列表里或已提交过申请都不再收
    if (await db.findLinkByUrl(dbx, url)) return err('该站点已在友链列表或已提交过申请');
    await db.addLink(dbx, { name, url, description, logo, contact, reason, status: 'pending', source: 'apply', ip });
    return capOn ? jset({ ok: true }, clearCaptchaCookie()) : json({ ok: true });
  }

  // ================= 以下全部需登录 =================
  const user = await authUser();
  if (!user) return err('未登录或会话已过期', 401);

  // --- IP 归属地：手动催一批（Ver 0.5 ⑦）---
  // 打开评论页时会自动补一批，这里给博主一个「继续补」的按钮：反复点到补完为止。
  if (seg[0] === 'ipgeo' && seg[1] === 'sync' && seg.length === 2 && method === 'POST') {
    if (!(await geoOn())) return err('IP 归属地功能已关闭', 403);
    let checked = 0, left = 0;
    try {
      const r = await dbx.prepare(`SELECT DISTINCT ip FROM comments WHERE ip<>'' LIMIT 500`).all();
      const all = ((r && r.results) || []).map((x) => String(x.ip || '').trim()).filter(ipgeo.isPublicIp);
      const m = await ipgeo.geoMap(dbx, all);
      const todo = all.filter((ip) => !m.has(ip));
      const batch = todo.slice(0, GEO_SYNC_MAX);
      left = todo.length - batch.length;
      if (batch.length) checked = (await ipgeo.geoSync(dbx, batch, await geoProvider(), { timeout: 4000 })).checked;
    } catch (e) { return err('补齐失败：' + e.message, 500); }
    return json({ ok: true, checked, left });
  }

  // --- 媒体（R2）：图片 / 视频 / 音频 ---
  if (seg[0] === 'media') {
    if (method === 'POST' && seg.length === 1) {
      const ctRaw = request.headers.get('content-type') || '';
      const ct = ctRaw.split(';')[0].trim().toLowerCase();
      const ext = MEDIA_TYPES[ct];
      if (!ext) {
        return err('不支持的文件类型：视频请用 MP4 / WebM / MOV，音频请用 MP3 / M4A / WAV / FLAC / OGG，图片请用 PNG / JPG / GIF / WebP / AVIF / BMP', 415);
      }
      const kind = mediaKindOf(ct);
      const max = MEDIA_MAX[kind];
      // 快路：带了 content-length 就直接拒，不用白流一个超大文件
      const len = parseInt(request.headers.get('content-length') || '0', 10);
      if (len > max) return err(mediaLimitMsg(kind, max), 413);
      const key = MEDIA_PREFIX + `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      // 上限与「已知长度」一起交给 putUpload：它带 content-length 时直接透传 request.body，
      // 不带时才边读边数。★ 这里绝不能自己 pipeThrough 数字节 —— 长度信息一丢，
      // R2 就报 "Provided readable stream must have a known length"，上传必 500。
      const up = await putUpload(env.BLOG, key, request, max,
        { httpMetadata: { contentType: ct }, customMetadata: { ct } });
      if (up.tooLarge) return err(mediaLimitMsg(kind, max), 413);
      if (up.empty) return err('没有收到文件内容', 400);
      // 注意：url 里不能再拼一次 media/ —— R2 的键已经带了，拼两次会变成
      // /media/media/xxx 取不到对象（图片显示不出来、视频放不了）。
      return json({ ok: true, key, url: '/media/' + key.slice(MEDIA_PREFIX.length), kind });
    }
    if (method === 'GET' && seg.length === 1) {
      const list = await env.BLOG.list({ prefix: 'media/', cursor: url.searchParams.get('cursor') || undefined, limit: 200 });
      return json({
        items: (list.objects || []).map((o) => ({
          key: o.key, size: o.size, uploaded: o.uploaded,
          // R2 的 uploaded 是 UTC，直接上屏会比文章、评论的时间早 8 小时。
          // 这里多给一份北京时间字符串，界面统一用它；uploaded 原样保留（排序、兼容老前端）。
          uploaded_bn: bnFromUTC(o.uploaded),
          ct: o.customMetadata?.ct || mimeOfExt(o.key),
          // R2 的键本身就带 media/ 前缀，再拼一次会得到 /media/media/xxx。
          // 取的时候虽然兼容这种写法，但界面里复制出来的地址要跟上传接口一致，
          // 否则粘进 Logo / 正文后会写进一份「历史格式」的路径。
          url: '/media/' + (o.key.startsWith(MEDIA_PREFIX) ? o.key.slice(MEDIA_PREFIX.length) : o.key),
        })),
        truncated: list.truncated, cursor: list.cursor,
      });
    }
    if (method === 'DELETE') {
      const key = String(url.searchParams.get('key') || '');
      if (!key.startsWith('media/')) return err('非法文件路径', 400);
      await env.BLOG.delete(key);
      return json({ ok: true });
    }
    return err('接口不存在', 404);
  }

  // --- 自定义字体上传（R2，Ver 0.6 ①）---
  // 只收字体文件，存 R2 的 fonts/ 前缀，与图片视频音频完全分开：
  // 混进 media/ 会让「媒体库」里多出一堆 <img> 加载不出来的裂图占位卡。
  if (seg[0] === 'fonts') {
    if (method !== 'POST' || seg.length !== 1) return err('方法不允许', 405);
    // 扩展名优先按前端带来的 ?ext= 判定：.ttf / .otf 在不少浏览器上被报成
    // application/octet-stream，只信 content-type 会把正常字体误判成不支持的类型。
    const wantExt = String(url.searchParams.get('ext') || '').toLowerCase().replace(/^\./, '');
    const ct = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const ext = font.FONT_EXTS.includes(wantExt) ? wantExt : (font.FONT_TYPES[ct] || '');
    if (!ext) return err('只支持 woff2 / woff / ttf / otf 字体文件', 415);
    const max = font.FONT_MAX;
    const len = parseInt(request.headers.get('content-length') || '0', 10);
    if (len > max) return err(font.fontLimitMsg, 413);
    const key = font.FONT_PREFIX + `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    // 与媒体上传同一个入口：带 content-length 直接透传，未知长度才缓冲（见 util.js putUpload）
    const up = await putUpload(env.BLOG, key, request, max,
      { httpMetadata: { contentType: font.FONT_MIME[ext] }, customMetadata: { ct: font.FONT_MIME[ext] } });
    if (up.tooLarge) return err(font.fontLimitMsg, 413);
    if (up.empty) return err('没有收到文件内容', 400);
    return json({ ok: true, key, url: '/fonts/' + key.slice(font.FONT_PREFIX.length), ext });
  }

  // --- 外站视频嵌入（B 站 / YouTube）---
  // 把「视频页面地址」换成播放器地址，正文里只存后者。b23.tv 分享短链要出网跟一次
  // 重定向，所以这个接口放在登录之后 —— 只有博主能触发，不给外人当跳板用。
  if (seg[0] === 'embed' && seg.length === 1) {
    if (method !== 'POST') return err('方法不允许', 405);
    const b = (await readJson(request)) || {};
    const r = await resolveEmbed(b.url);
    if (!r.ok) return err(r.error || '解析失败', 400);
    return json(r);
  }

  // --- 数据导入（Ver 0.7 ①）---
  // 流程：GET /meta 拿本站现状（各表最大 id 与已有 slug）→ 浏览器解析 .sql 并算好
  // 重编号 → POST /apply 分批写入 → 出错时 POST /undo 按 id 区间回滚。
  // 解析为什么不在服务端：Workers 免费版单请求 CPU 约 10ms，几 MB 的 SQL 逐字符
  // 扫描必然超时；浏览器解析完只回传规整后的行，服务端的工作量与文件大小无关。
  if (seg[0] === 'import') {
    if (!(await authUser())) return err('未登录', 401);
    try {
      if (method === 'GET' && seg[1] === 'meta') {
        return json(await importdb.importMeta(dbx));
      }
      if (method === 'POST' && seg[1] === 'apply') {
        const b = (await readJson(request)) || {};
        const table = String(b.table || '');
        const rows = Array.isArray(b.rows) ? b.rows : [];
        return json({ ok: true, ...(await importdb.insertBatch(dbx, table, rows)) });
      }
      if (method === 'POST' && seg[1] === 'undo') {
        const b = (await readJson(request)) || {};
        return json({ ok: true, ...(await importdb.undoImport(dbx, b.ranges || {})) });
      }
      if (method === 'POST' && seg[1] === 'done') {
        // 新内容落库后把首页与列表页的缓存清掉；没配 purge 就等 10 分钟新鲜期自然过期
        clearPaths(['/', '/page/1']);
        return json({ ok: true });
      }
    } catch (e) {
      if (e instanceof importdb.ImportError) return err(e.message, e.status);
      throw e;
    }
    return err('未找到', 404);
  }

  // --- 备份（R2） ---
  // 说明：路由是单数 /api/backup；'backups' 作为别名保留，兼容旧版前端的复数写法
  if (seg[0] === 'backup' || seg[0] === 'backups') {
    // GET /api/backup/sql?fmt=sqlite|mysql|pg —— 导出整库为可导入的 .sql（Ver 0.6 ⑦ / ⑧）
    // ⚠️ 必须放在下面那条「GET /:name 取 R2 里的备份」之前，否则 `sql` 会被当成备份文件名去 R2 查，永远 404。
    // 只下载、不落 R2（Wei 的选择）：不占空间，也不打扰上面那套「最多 20 份」的轮转。
    // GET /api/backup/sql?fmt=sqlite|mysql|pg[&to=typecho|zblog|wordpress][&prefix=xxx][&mode=append|shift|wipe][&offset=100000]
    //   · 不带 to（或 to=default）→ 整库导出（Ver 0.6 ⑦ / ⑧ 第一步）
    //   · 带 to → 目标程序迁移文件（只数据；表名/列名与字段映射全在 _lib/targets.js）
    if (method === 'GET' && seg.length === 2 && seg[1] === 'sql') {
      // fmt 的归一交给 _lib/sql.js 的 normalizeFmt —— 全项目只此一份判定，别在这儿再抄一份。
      // 认 sqlite / mysql / pg；另外 postgres、postgresql、pgsql 也归一到 pg，其余值回落 sqlite。
      const fmt = sqldump.normalizeFmt(url.searchParams.get('fmt'));
      const label = fmt === 'pg' ? 'postgres' : fmt;
      const stamp = bnNow();
      const toKey = targets.normalizeTarget(url.searchParams.get('to'));
      if (!toKey) {
        const text = await sqldump.dumpSql(dbx, fmt, stamp);
        // 文件名里把 pg 写成 postgres —— 给 Wei 看着明白：blog-postgres-20261015123456.sql
        return sqlFile(text, 'blog-' + label + '-' + stamp.replace(/[-: ]/g, '') + '.sql');
      }
      const prog = targets.TARGETS[toKey];
      // 不支持的组合**明确拒绝**，绝不「回落成整库导出」—— 否则用户以为拿到了 WordPress 文件，
      // 实际是一份 WordPress 根本不认识的自建表结构（官方只支持 MySQL）。
      if (!prog.allow.includes(fmt)) {
        return err(prog.label + ' 只支持 ' + prog.allow.map((x) => (x === 'pg' ? 'postgres' : x)).join(' / ') + '，不支持 ' + label, 400);
      }
      const prefix = targets.sanitizePrefix(url.searchParams.get('prefix')) || prog.prefix;
      const override = await readTargetSchema(env, toKey, prefix);
      // ★ 目标站已经有的行怎么处理：&mode=append|shift|wipe 三档互斥，**不传 = append 只追加**
      //   （2026-10-16）。默认值一律落在「不动目标站数据」这一侧 —— 这跟 ⑨ 的 DELETE 是同一条
      //   教训：清空 / 覆盖类开关一旦默认成真，一次误点就不可逆地清掉别人的站。
      //   &offset 只在 shift 档有意义（我们的内容整体换一段新编号追加，目标站一行不动）。
      //   两个参数的归一与兜底都在 _lib/targets.js 里，**路由不自己判**（全项目只此一份）。
      const mode = url.searchParams.get('mode');
      const offset = url.searchParams.get('offset');
      const text = await targets.dumpTarget(dbx, fmt, toKey, stamp, { prefix, override, mode, offset });
      return sqlFile(text, 'blog-' + label + '-' + toKey + '-' + stamp.replace(/[-: ]/g, '') + '.sql');
    }
    // /api/backup/schema?to=typecho|zblog|wordpress —— 目标程序建表脚本的上传覆盖
    //   存 R2，只用来学「表名与列名」；DDL 本身永远不进导出产物。
    // ⚠️ 同样必须排在下面「GET /:name 取 R2 备份」之前，否则 `schema` 会被当成备份文件名。
    if (seg.length === 2 && seg[1] === 'schema') {
      // 不带 to 的 GET 是「能力表」：后台拿它渲染下拉与按钮禁用状态，
      // 免得前端再手抄一份「哪个程序支持哪些方言」。
      if (method === 'GET' && !targets.normalizeTarget(url.searchParams.get('to'))) {
        return json({ targets: targets.targetCapability() });
      }
      const toKey = targets.normalizeTarget(url.searchParams.get('to'));
      if (!toKey) return err('请指定目标程序：to=typecho|zblog|wordpress', 400);
      const prog = targets.TARGETS[toKey];
      const prefix = targets.sanitizePrefix(url.searchParams.get('prefix')) || prog.prefix;
      const key = targetSchemaKey(toKey);
      if (method === 'GET') {
        const obj = await env.BLOG.get(key);
        const base = { target: toKey, label: prog.label, defaultPrefix: prog.prefix, prefix, builtin: !obj };
        if (!obj) return json(Object.assign(base, { tables: [] }));
        const tables = targets.parseSchema(await obj.text(), prefix);
        return json(Object.assign(base, {
          size: obj.size, uploaded: obj.uploaded,
          tables: tables.map((t) => ({ name: t.name, cols: t.cols.length })),
        }));
      }
      if (method === 'POST') {
        const body = await request.text();
        // 上限 256KB：Typecho 的建表脚本 4KB、Z-Blog 6KB、WordPress 拆出来约 10KB，
        // 给足余量，又不至于让人把整个数据库倒进 R2。
        if (body.length > 262144) return err('文件太大（上限 256KB）', 413);
        if (!/CREATE\s+TABLE/i.test(body)) return err('这份文件里没有 CREATE TABLE，不像建表脚本', 400);
        const tables = targets.parseSchema(body, prefix);
        if (!tables.length) return err('没能从这份文件里解析出任何表，请确认它是对应程序的建表脚本', 400);
        await env.BLOG.put(key, body, { httpMetadata: { contentType: 'text/plain; charset=utf-8' } });
        return json({ ok: true, target: toKey, tables: tables.map((t) => t.name) });
      }
      if (method === 'DELETE') {
        await env.BLOG.delete(key);
        return json({ ok: true, target: toKey, builtin: true });
      }
      return err('方法不支持', 405);
    }
    // GET /api/backup/md[?media=1] —— 导出为静态站点用的 Markdown 压缩包（Ver 0.6 ⑧）
    // 产物按 Hexo 惯例组织：_posts/YYYY-MM-DD-别名.md + pages/ + _comments.json（+ media/）。
    // ⚠️ 与上面 sql / schema 两条同一条铁律：**必须排在下面「GET /:name 取 R2 备份」之前**，
    //    否则 `md` 会被当成备份文件名去 R2 查，永远 404。
    if (method === 'GET' && seg.length === 2 && seg[1] === 'md') {
      const withMedia = url.searchParams.get('media') === '1';
      const stamp = bnNow();
      // 不勾选打包图片时，正文里的站内路径要改写成绝对地址 —— 得先知道站点自己的域名。
      // 设置里配了 site_url 就用它（自定义域），没配就回落到本次请求的域名。
      const sm = await db.settingsMap(dbx);
      const base = String((sm && sm.get && sm.get('site_url')) || '').trim() || url.origin;
      let out;
      try {
        out = await hexo.dumpHexo(dbx, {
          origin: base.replace(/\/+$/, ''),
          withMedia,
          r2: env.BLOG,
          nowText: stamp,
        });
      } catch (e) {
        // 「图片太多 / 合计太大 / 读不到 R2」这些都得原样告诉用户怎么办，
        // 吞成一个 500 只会让人以为站点坏了
        return err(e.message || '导出失败', 400);
      }
      return zipFile(await zip.makeZip(out.files), 'blog-hexo-' + stamp.replace(/[-: ]/g, '') + '.zip');
    }
    if (method === 'POST' && seg.length === 1) {
      const data = await db.dumpAll(dbx);
      // 文件名只精确到秒：同一秒内连点两次备份会生成同名文件互相覆盖，补 4 位随机后缀避免
      const rnd = Math.random().toString(36).slice(2, 6);
      const key = `backups/backup-${bnNow().replace(/[-: ]/g, '')}-${rnd}.json`;
      await env.BLOG.put(key, JSON.stringify(data, null, 2), { httpMetadata: { contentType: 'application/json' }, customMetadata: { ct: 'application/json' } });
      const all = (await env.BLOG.list({ prefix: 'backups/' })).objects || [];
      const old = all.sort((a, b) => b.uploaded - a.uploaded).slice(20);
      for (const o of old) await env.BLOG.delete(o.key);
      return json({ ok: true, key });
    }
    if (method === 'GET' && seg.length === 1) {
      const all = (await env.BLOG.list({ prefix: 'backups/', limit: 100 })).objects || [];
      // uploaded 是 R2 给的 UTC；界面按北京时间显示（否则备份时间会早 8 小时）
      return json({ items: all.sort((a, b) => b.uploaded - a.uploaded).map((o) => ({ key: o.key, size: o.size, uploaded: o.uploaded, uploaded_bn: bnFromUTC(o.uploaded), name: o.key.split('/').pop() })) });
    }
    if (method === 'GET' && seg.length === 2 && seg[1] !== 'restore') {
      const obj = await env.BLOG.get('backups/' + seg[1]);
      if (!obj) return err('备份不存在', 404);
      return new Response(obj.body, { headers: { 'content-type': 'application/json', 'content-disposition': `attachment; filename="${seg[1]}"` } });
    }
    // DELETE /api/backup/:name —— 从 R2 删除指定备份
    if (method === 'DELETE' && seg.length === 2) {
      const name = String(seg[1] || '');
      // 只允许 backups/ 下的单层文件名：挡住 `../`、`a/b` 这类穿越写法，
      // 否则传 `../media/xxx` 就能删掉图片库里的文件
      if (!/^[A-Za-z0-9._-]+\.json$/.test(name)) return err('备份文件名不合法', 400);
      const key = 'backups/' + name;
      // head 只取元信息不下载正文，备份文件可能有几 MB
      const exist = env.BLOG.head ? await env.BLOG.head(key) : await env.BLOG.get(key);
      if (!exist) return err('备份不存在或已被删除', 404);
      await env.BLOG.delete(key);
      return json({ ok: true, deleted: name });
    }
    if (seg[1] === 'restore' && method === 'POST' && seg.length === 2) {
      const b = (await readJson(request)) || {};
      let data = b.data;
      if (b.key) {
        const obj = await env.BLOG.get(String(b.key));
        if (!obj) return err('备份不存在', 404);
        data = await obj.json();
      }
      if (!data || !Array.isArray(data.posts)) return err('备份数据格式不正确');
      const n = await db.restoreAll(dbx, data);
      clearAll();
      return json({ ok: true, restored: n });
    }
    return err('接口不存在', 404);
  }

  // --- 主题管理（R2 themes/ 前缀；default 为内置主题） ---
  if (seg[0] === 'themes') {
    // GET /api/themes —— 列出内置 + 已上传主题
    if (method === 'GET' && seg.length === 1) {
      const active = (await db.getSetting(dbx, 'active_theme')) || 'default';
      const items = [{
        id: 'default', name: '系统默认', author: '内置', version: '1.0',
        description: '页面骨架自带的默认外观（浅色），无需任何文件。', builtin: true, active: active === 'default',
      }];
      // 预置主题（Ver 0.7 ⑥）：随仓库发布，不查 R2 也能列出来。
      // 不用 R2.list 一起扫 —— 它们的文件根本不在 R2 里。
      for (const t of presets.all()) items.push({ ...t, active: active === t.id });
      const list = await env.BLOG.list({ prefix: 'themes/', limit: 1000 });
      const ids = new Set();
      for (const o of list.objects || []) {
        const m = /^themes\/([^/]+)\//.exec(o.key);
        if (m) ids.add(m[1]);
      }
      for (const id of [...ids].sort()) {
        // 同 id 的以预置那条为准，免得列表里出现两行一模一样的主题。
        // （用户上传的同名文件仍然生效：资源代理是「R2 先、预置后」。）
        if (presets.isPreset(id)) continue;
        const meta = { id, name: id, author: '', version: '', description: '', builtin: false, active: active === id };
        try {
          const j = await env.BLOG.get('themes/' + id + '/theme.json');
          if (j) {
            const t = await j.json();
            meta.name = String(t.name || id).slice(0, 60);
            meta.author = String(t.author || '').slice(0, 60);
            meta.version = String(t.version || '').slice(0, 20);
            meta.description = String(t.description || '').slice(0, 300);
          }
        } catch (e) { /* 元信息缺失或损坏时用 id 兜底 */ }
        items.push(meta);
      }
      return json({ items, active });
    }

    // POST /api/themes/upload?dir=<id>&path=<相对路径>  body=文件原始字节
    if (method === 'POST' && seg[1] === 'upload' && seg.length === 2) {
      const dir = String(url.searchParams.get('dir') || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
      if (!dir || dir === 'default' || !/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(dir)) {
        return err('主题 ID 需为小写字母/数字/连字符（且不可用 default）', 400);
      }
      const rel = String(url.searchParams.get('path') || '').split('/').filter((x) => x && x !== '.' && x !== '..' && !x.includes('\\'));
      if (!rel.length || rel.join('/').length > 160) return err('非法文件路径', 400);
      const len = parseInt(request.headers.get('content-length') || '0', 10);
      if (len > 5 * 1024 * 1024) return err('主题单文件不能超过 5MB', 413);
      const key = `themes/${dir}/${rel.join('/')}`;
      const ct = mimeOfExt(key);
      await env.BLOG.put(key, request.body, { httpMetadata: { contentType: ct }, customMetadata: { ct } });
      return json({ ok: true, key });
    }

    // POST /api/themes/activate  body:{id}
    if (method === 'POST' && seg[1] === 'activate' && seg.length === 2) {
      const b = (await readJson(request)) || {};
      const id = String(b.id || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
      if (!id || id === 'default') {
        await db.setSetting(dbx, 'active_theme', 'default');
        clearAll();
        return json({ ok: true, active: 'default' });
      }
      if (!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(id)) return err('主题 ID 不合法', 400);
      // 预置主题的文件在 public/themes/，R2 里查不到是正常的，不能因此判它不存在
      if (!presets.isPreset(id)) {
        const css = await env.BLOG.get('themes/' + id + '/style.css');
        if (!css) return err('主题不存在或缺少 style.css', 404);
      }
      await db.setSetting(dbx, 'active_theme', id);
      clearAll();
      return json({ ok: true, active: id });
    }

    // DELETE /api/themes/:id —— 删除主题文件；若正被启用则自动回退内置默认
    if (method === 'DELETE' && seg.length === 2) {
      const id = String(seg[1]).toLowerCase().replace(/[^a-z0-9-]+/g, '').slice(0, 40);
      if (!id || id === 'default') return err('内置主题不可删除', 400);
      // 预置主题的文件在仓库里，R2 里本来就没有东西可删 —— 混进来只会清空一个不存在的目录，
      // 让人误以为「删掉了」。直接拒绝，并说清正确的改法。
      if (presets.isPreset(id)) {
        return err('预置主题随仓库发布，不能删除；想改它的样式，请上传一份同 id 的主题覆盖', 400);
      }
      let cursor;
      let deleted = 0;
      do {
        const r = await env.BLOG.list({ prefix: 'themes/' + id + '/', limit: 1000, cursor });
        for (const o of r.objects || []) { await env.BLOG.delete(o.key); deleted++; }
        cursor = r.truncated ? r.cursor : undefined;
      } while (cursor);
      const active = (await db.getSetting(dbx, 'active_theme')) || 'default';
      if (active === id) {
        await db.setSetting(dbx, 'active_theme', 'default');
        clearAll();
        return json({ ok: true, deleted, activeFallback: 'default' });
      }
      clearAll();
      return json({ ok: true, deleted });
    }
    return err('接口不存在', 404);
  }

  // --- 统计 ---
  if (seg[0] === 'stats' && method === 'GET' && seg.length === 1) return json(await db.stats(dbx));

  // --- 仪表盘（后台首页）---
  // 一次拿齐：总览数字 + 待审评论 + 最近文章 / 最近评论 / 热门文章。
  // 所有查询并行发起，避免串行往返把 D1 延迟叠加起来。
  if (seg[0] === 'dashboard' && method === 'GET' && seg.length === 1) {
    const monthStart = bnNow().slice(0, 8) + '01'; // 本月 1 号 00:00（北京时间字符串可直接比大小）
    // 下面 Promise.all 里有几条手写 SQL 直接用 posts.deleted_at，而补列是在 stats()/listPosts()
    // 内部做的。并发发起时手写 SQL 可能先跑，老库上就会 no such column —— 先显式等补列。
    await db.ensurePostCols(dbx);
    const nOf = (r) => (r && r.n) || 0;
    const [st, pending, recent, cmts, top, mPosts, mCmts, words, views, pv, linkCnt, linkPending, sm] = await Promise.all([
      db.stats(dbx),
      db.listComments(dbx, { status: 'pending', limit: 5 }),
      // 「最近文章」语义上就是按时间排，置顶不该插进来（pinFirst:false）
      db.listPosts(dbx, { status: 'all', per: 6, pinFirst: false }),
      db.listComments(dbx, { status: 'all', limit: 6 }),
      dbx.prepare(`SELECT p.id,p.title,p.slug,p.view_count,p.published_at,c.slug AS cat_slug FROM posts p
                   LEFT JOIN categories c ON c.id=p.category_id WHERE p.status='published'
                     AND (p.deleted_at IS NULL OR p.deleted_at='')
                   ORDER BY p.view_count DESC, p.id DESC LIMIT 5`).all(),
      dbx.prepare(`SELECT COUNT(*) n FROM posts WHERE created_at>=?
                     AND (deleted_at IS NULL OR deleted_at='')`).bind(monthStart).first(),
      dbx.prepare(`SELECT COUNT(*) n FROM comments WHERE created_at>=?`).bind(monthStart).first(),
      // 字数按 Markdown 源码统计：SQLite 的 length() 对文本返回字符数（不是字节），中文不会被放大 3 倍
      dbx.prepare(`SELECT COALESCE(SUM(LENGTH(content_md)),0) n FROM posts
                     WHERE (deleted_at IS NULL OR deleted_at='')`).first(),
      dbx.prepare(`SELECT COALESCE(SUM(view_count),0) n FROM posts
                     WHERE (deleted_at IS NULL OR deleted_at='')`).first(),
      // 访问统计表可能尚未建立（老库），失败要给出 null 而不是让整个仪表盘 500
      db.pvSummary(dbx, 7).catch(() => null),
      // 友链表同理：老库还没建时不能拖垮整个仪表盘
      db.countLinksByStatus(dbx).catch(() => ({ pending: 0, approved: 0, rejected: 0 })),
      db.listLinks(dbx, { status: 'pending' }).then((l) => l.slice(0, 5)).catch(() => []),
      db.settingsMap(dbx),   // 取永久链接规则，给下面两条列表补上文章地址
    ]);
    // 裁剪字段：正文等大字段不下发，省流量也省前端解析
    const tc = (c) => ({
      id: c.id, author: c.author, content: c.content, status: c.status,
      is_admin: c.is_admin, created_at: c.created_at,
      post_title: c.post_title, post_slug: c.post_slug,
    });
    return json({
      counts: { ...st, views: nOf(views), words: nOf(words), month_posts: nOf(mPosts), month_comments: nOf(mCmts) },
      pending: pending.map(tc),
      recent_posts: recent.items.map((p) => ({
        id: p.id, title: p.title, slug: p.slug, status: p.status,
        published_at: p.published_at, updated_at: p.updated_at,
        views: p.view_count || 0, comments: p.comment_count || 0, url: postUrl(sm, p),
      })),
      recent_comments: cmts.map(tc),
      top_posts: (top.results || []).map((r) => ({ id: r.id, title: r.title, slug: r.slug, views: r.view_count || 0, url: postUrl(sm, r) })),
      // pv 为 null = 访问统计不可用（表还没建或查询失败），前端显示「未开启」
      pv: pv || null,
      // 友链：待审数量 + 最近几条待审申请（仪表盘直接给出提醒与处理入口）
      links: { pending: (linkCnt && linkCnt.pending) || 0, approved: (linkCnt && linkCnt.approved) || 0,
        pending_list: (linkPending || []).map((l) => ({
          id: l.id, name: l.name, url: l.url, description: l.description,
          contact: l.contact, reason: l.reason, created_at: l.created_at,
        })) },
      generated_at: bnNow(),
    });
  }

  // --- 预览（返回完整 HTML 供编辑器 iframe 展示） ---
  if (seg[0] === 'preview' && method === 'POST' && seg.length === 1) {
    const b = (await readJson(request)) || {};
    const s = await db.settingsMap(dbx);
    const post = { title: String(b.title || '').trim().slice(0, 200), content_html: render(String(b.content_md || '')) };
    return json({ html: site.previewDoc(s, post, url.origin) });
  }

  // --- 设置 ---
  // /api/settings/read 是后台读取设置的地址（与写入用的 /api/settings 同一份数据）；
  // 之前只认 seg.length===1，读设置会落到 404，设置页所有输入框都是空的。
  if (seg[0] === 'settings' && (seg.length === 1 || (seg[1] === 'read' && seg.length === 2))) {
    if (method === 'GET') {
      const all = await db.allSettings(dbx);
      // 发信授权码任何情况下都不回传（回显只会增加泄露面）
      // 本接口位于登录守卫之后，属私有接口；这里再兜一层，防止日后被挪到公开区
      const hasPass = !!all.mail_pass;
      // Cloudflare API Token 同样只回传「有没有配过」，绝不把值送回浏览器。
      // 它比邮件授权码更敏感：拿到就能读整个 Zone 的流量数据。
      const hasCfToken = !!all.cf_api_token;
      // 搜索引擎推送密钥同理：只回传「有没有配过」，值不出服务端
      const hasBaidu = !!all.baidu_token;
      const hasIndexnow = !!all.indexnow_key;
      delete all.admin_pass_hash;
      delete all.admin_pass_salt;
      delete all.admin_pass_iter;
      delete all.mail_pass;
      delete all.cf_api_token;
      delete all.baidu_token;
      delete all.indexnow_key;
      all.mail_pass_set = hasPass ? '1' : '0';
      all.cf_api_token_set = hasCfToken ? '1' : '0';
      all.baidu_token_set = hasBaidu ? '1' : '0';
      all.indexnow_key_set = hasIndexnow ? '1' : '0';
      if (!(await authUser())) delete all.email;
      return json(all);
    }
    if (method === 'PATCH' && seg.length === 1) {
    const b = (await readJson(request)) || {};
    // ★ 所有「会整条拒绝」的校验必须全部做完再开始写库。
    //   以前是边校验边写：permalink / email 排在 logo 前面，一旦不合法就直接 return，
    //   排在后面的 logo、favicon、侧边栏等字段一个都没写。用户看到的是「邮箱格式不正确」，
    //   却会在下一次保存时发现 Logo 莫名其妙回到了默认（Ver 0.7 ⑩ 踩过）。
    // 永久链接：不合法直接拒；空串表示恢复默认
    const pmVal = b.permalink != null ? normalizePermalink(b.permalink) : null;
    if (b.permalink != null && !pmVal) {
      return err('永久链接格式不合法：需以 / 开头且包含 {slug} 或 {id}，可用变量 {year} {month} {day} {category}');
    }
    // 博主邮箱：留空表示清除，填了必须是合法格式（不验证是否真实存在）。
    // 先按原值校验、写入时再截断：先截断会把超长的非法地址截成「看起来合法」。
    const em = b.email != null ? String(b.email).trim() : null;
    if (em && !isEmail(em)) return err('邮箱格式不正确（示例：name@example.com）');
    // 图标地址：只接受站内相对路径或 http(s)，挡掉 javascript: 等伪协议；传空串表示清除。
    // ★ 非空却不合法时必须报错：以前是静默存成空串、接口照样回 200「已保存」，
    //   现象正是「明明设过 Logo，前台一直是默认方块，后台输入框还空了」。
    const safeUrl = (v) => (/^(https?:\/\/|\/)/i.test(String(v || '').trim()) ? String(v).trim().slice(0, 300) : '');
    const logoVal = b.logo_image != null ? safeUrl(b.logo_image) : null;
    if (b.logo_image != null && String(b.logo_image).trim() && !logoVal) {
      return err('Logo 地址不合法：需以 / 开头（站内图片）或 http(s):// 开头');
    }
    const favVal = b.favicon_image != null ? safeUrl(b.favicon_image) : null;
    if (b.favicon_image != null && String(b.favicon_image).trim() && !favVal) {
      return err('Favicon 地址不合法：需以 / 开头（站内图片）或 http(s):// 开头');
    }
    // 搜索引擎推送密钥（Ver 0.8 ①）：格式不对在这里就拒，别等推送时才回一句「密钥无效」。
    // 空串 = 保持原值（表单里那个框默认不回显真密钥），要清除走下面的 *_clear 标记。
    const baiduVal = b.baidu_token != null && String(b.baidu_token).trim() ? seo.safeToken(b.baidu_token) : null;
    if (baiduVal === '') return err('百度准入密钥格式不对：应为 6–80 位字母、数字、下划线或连字符');
    const indexnowVal = b.indexnow_key != null && String(b.indexnow_key).trim() ? seo.safeKey(b.indexnow_key) : null;
    if (indexnowVal === '') return err('IndexNow 密钥格式不对：8–128 位，只能用字母、数字与连字符');
    // ---- 校验全过，开始写库 ----
    if (pmVal != null) await db.setSetting(dbx, 'permalink', pmVal);
    if (em != null) await db.setSetting(dbx, 'email', em.slice(0, 120));
    const allowed = { site_title: 60, site_subtitle: 80, author_name: 30, footer_text: 500, seo_desc: 200, beian: 100, copyright: 600 };
    // 代码高亮主题与头像源：取值受限，避免写入任意值
    if (b.code_theme != null) {
      const t = String(b.code_theme).slice(0, 30);
      if (CODE_THEMES.some((x) => x.id === t)) await db.setSetting(dbx, 'code_theme', t);
    }
    if (b.gravatar_source != null) {
      const g = String(b.gravatar_source).slice(0, 20);
      if (['weavatar', 'cravatar', 'sepcc', 'gravatar', 'secure'].includes(g)) await db.setSetting(dbx, 'gravatar_source', g);
    }
    for (const k of Object.keys(allowed)) {
      if (b[k] != null) await db.setSetting(dbx, k, String(b[k]).slice(0, allowed[k]));
    }
    // 图标地址（校验在最前面已做完，这里只落库；空串 = 清除）
    if (logoVal != null) await db.setSetting(dbx, 'logo_image', logoVal);
    if (favVal != null) await db.setSetting(dbx, 'favicon_image', favVal);
    if (b.per_page != null) await db.setSetting(dbx, 'per_page', String(Math.min(20, Math.max(1, parseInt(b.per_page, 10) || 8))));
    if (b.allow_comments != null) await db.setSetting(dbx, 'allow_comments', b.allow_comments ? '1' : '0');
    if (b.comment_audit != null) await db.setSetting(dbx, 'comment_audit', b.comment_audit ? '1' : '0');
    if (b.captcha != null) await db.setSetting(dbx, 'captcha', b.captcha ? '1' : '0');
    // ---- 旧评论外链降级（Ver 0.6 ⑩）：默认开、默认 365 天 ----
    // 只影响渲染时「要不要输出 <a>」，一条评论数据都不改；改完末尾 clearAll() 会清缓存。
    // 天数按「正数才算数」夹取：0 / 负数 / 非数字一律回落到默认 365，不让人一个手滑关掉整站外链。
    if (b.comment_link_on != null) await db.setSetting(dbx, 'comment_link_on', b.comment_link_on ? '1' : '0');
    if (b.comment_link_days != null) {
      const n = parseInt(b.comment_link_days, 10);
      await db.setSetting(dbx, 'comment_link_days',
        String(n > 0 ? Math.min(site.COMMENT_LINK_MAX_DAYS, n) : site.COMMENT_LINK_DAYS));
    }
    // ---- IP 归属地（Ver 0.5 ⑦）：开关默认开；接口只认白名单里的 id，
    //      传了别的一律忽略（读的一方还有 pickProvider 兜底，双保险）----
    if (b.ipgeo_on != null) await db.setSetting(dbx, 'ipgeo_on', b.ipgeo_on ? '1' : '0');
    if (b.ipgeo_src != null && ipgeo.isProvider(b.ipgeo_src)) await db.setSetting(dbx, 'ipgeo_src', String(b.ipgeo_src));
    // ---- 文章目录（Ver 0.5 ⑧）：默认开；关掉后文章页不再出现目录卡片 ----
    // 目录是渲染文章页时现场生成的，改这个开关不用动任何文章数据。
    if (b.toc_on != null) await db.setSetting(dbx, 'toc_on', b.toc_on ? '1' : '0');
    // ---- 导航栏显示开关：关掉只是不出现在页头导航，页面地址照常可访问 ----
    for (const k of ['categories', 'tags', 'archive', 'links', 'rss']) {
      if (b['nav_show_' + k] != null) await db.setSetting(dbx, 'nav_show_' + k, b['nav_show_' + k] ? '1' : '0');
    }
    // ---- 侧边栏（Ver 0.5 ②）：默认关闭；开启后前台两列 ----
    // items 是 JSON 数组，一律过 normalizeItems 清洗（未知类型丢弃、条数夹在 1–30、
    // 标题与正文限长），脏配置最多是侧边栏不出现，不会把坏数据带进页面。
    if (b.sidebar_enabled != null) await db.setSetting(dbx, 'sidebar_enabled', b.sidebar_enabled ? '1' : '0');
    if (b.sidebar_side != null) await db.setSetting(dbx, 'sidebar_side', String(b.sidebar_side) === 'left' ? 'left' : 'right');
    if (b.sidebar_items != null) {
      await db.setSetting(dbx, 'sidebar_items', JSON.stringify(normalizeItems(b.sidebar_items)));
    }
    // ---- 服务器状态挂件（Ver 0.7 ⑤）：Cloudflare Analytics 是可选增强 ----
    // Zone ID 与 API Token 都留空时，前台只显示本站自算的指标（数据库延迟 / 体积 /
    // 媒体量 / 待审 / 运行天数），一个外部请求都不发。
    // Token 按「留空 = 保持原值」处理，跟邮件授权码一个规矩：否则每次点保存，
    // 表单里那个被打了码的框一提交就把真 Token 冲成空串了。
    if (b.cf_zone_id != null) await db.setSetting(dbx, 'cf_zone_id', String(b.cf_zone_id).trim().slice(0, 64));
    if (b.cf_api_token != null && String(b.cf_api_token).trim()) {
      await db.setSetting(dbx, 'cf_api_token', String(b.cf_api_token).trim().slice(0, 200));
    }
    if (b.cf_clear_token) await db.setSetting(dbx, 'cf_api_token', '');
    // 配置一动就把快照作废：否则最长一小时都还在显示旧数字，或者旧的那条报错
    if (b.cf_zone_id != null || b.cf_api_token != null || b.cf_clear_token) {
      await db.setSetting(dbx, '_cf_stat', '');
    }
    // ---- 全站灰度：默认关，启用后整站转灰（优先级高于主题） ----
    if (b.gray_mode != null) await db.setSetting(dbx, 'gray_mode', b.gray_mode ? '1' : '0');
    // ---- 自定义文章字体（Ver 0.6 ①）：默认关 ----
    // 字体名与链接最终都会拼进 CSS，所以一律先过 font.js 的白名单再落库 ——
    // 名字里一个 } 就能把后面的规则全带跑，入库前挡住比渲染时补救可靠。
    // 洗完之后为空串（比如只填了引号和分号）也照存：等于「没配」，渲染层会整体忽略。
    if (b.font_on != null) await db.setSetting(dbx, 'font_on', b.font_on ? '1' : '0');
    if (b.font_src != null) await db.setSetting(dbx, 'font_src', String(b.font_src) === 'remote' ? 'remote' : 'local');
    if (b.font_local != null) await db.setSetting(dbx, 'font_local', font.safeFontUrl(b.font_local));
    if (b.font_remote != null) await db.setSetting(dbx, 'font_remote', font.safeFontUrl(b.font_remote));
    if (b.font_family != null) await db.setSetting(dbx, 'font_family', font.safeFamily(b.font_family));
    // ---- 搜索引擎推送（Ver 0.8 ①）：默认关 ----
    // 两个密钥都「只写不读」：表单里留空表示保持原值，要清除必须显式传 *_clear，
    // 否则每次点保存都会把已经填好的密钥冲成空串（邮件授权码踩过同一个坑）。
    if (b.seo_push_on != null) await db.setSetting(dbx, 'seo_push_on', b.seo_push_on ? '1' : '0');
    if (baiduVal) await db.setSetting(dbx, 'baidu_token', baiduVal);
    if (b.baidu_clear_token) await db.setSetting(dbx, 'baidu_token', '');
    if (indexnowVal) await db.setSetting(dbx, 'indexnow_key', indexnowVal);
    if (b.indexnow_clear_key) await db.setSetting(dbx, 'indexnow_key', '');
    // ---- 音频播放（Ver 0.6 ③）：默认关；只播流媒体地址，不接本地上传 ----
    // 列表是 JSON 数组，一律过 normalizeAudio 清洗：地址必须 http(s):// 或站内 / 开头
    // （挡住 javascript: / data: 这类伪协议），标题剥尖括号，条数夹在 60 以内。
    // 洗不干净的条目直接丢，最多是前台少一条音频，不会把坏值带进页面。
    if (b.audio_on != null) await db.setSetting(dbx, 'audio_on', b.audio_on ? '1' : '0');
    if (b.audio_title != null) await db.setSetting(dbx, 'audio_title', audio.safeTitle(b.audio_title));
    if (b.audio_list != null) {
      await db.setSetting(dbx, 'audio_list', JSON.stringify(audio.normalizeAudio(b.audio_list)));
    }
    // ---- 邮件通知 ----
    // 端口必须是该服务商真开了的（163 没有 587、Office365 没有 465）。
    // 存了不支持的组合，现象是「连上就断」或「干等到超时」，与账号密码无关、极难排查，所以入库前拦住。
    if (b.mail_provider != null || b.mail_port != null || b.mail_secure != null) {
      const cur = await db.settingsMap(dbx);
      const tryCfg = {
        provider: b.mail_provider != null ? String(b.mail_provider).trim() : (cur.get('mail_provider') || '163'),
        port: b.mail_port != null ? parseInt(b.mail_port, 10) : (parseInt(cur.get('mail_port'), 10) || 465),
        secure: b.mail_secure != null
          ? (String(b.mail_secure) === 'starttls' ? 'starttls' : 'ssl')
          : (cur.get('mail_secure') === 'starttls' ? 'starttls' : 'ssl'),
      };
      const pi = mailPortIssue(tryCfg);
      if (pi) return err(pi, 400);
    }
    const MAIL_STR = { mail_provider: 20, mail_host: 120, mail_secure: 10, mail_user: 120, mail_from_name: 60, mail_template: 20 };
    for (const k of Object.keys(MAIL_STR)) {
      if (b[k] != null) await db.setSetting(dbx, k, String(b[k]).trim().slice(0, MAIL_STR[k]));
    }
    for (const k of ['mail_enabled', 'mail_on_comment', 'mail_on_reply']) {
      if (b[k] != null) await db.setSetting(dbx, k, b[k] ? '1' : '0');
    }
    // 授权码只写不读：留空表示保持原值，要清除需显式传 mail_clear_pass
    if (b.mail_pass != null && String(b.mail_pass) !== '') {
      await db.setSetting(dbx, 'mail_pass', String(b.mail_pass).slice(0, 200));
    } else if (b.mail_clear_pass === true) {
      await db.setSetting(dbx, 'mail_pass', '');
    }
    if (b.mail_port != null) {
      const p = parseInt(b.mail_port, 10);
      // 25 端口在 Cloudflare 上被禁，直接拒，免得配完发不出去还查不出原因
      if (p === 25) return err('Cloudflare 禁止 25 端口，请使用 465（SSL）或 587（STARTTLS）');
      await db.setSetting(dbx, 'mail_port', String(Math.min(65535, Math.max(1, p || 465))));
    }
    if (b.accent && isHexColor(String(b.accent))) await db.setSetting(dbx, 'accent', b.accent);
    if (b.new_password && String(b.new_password).length >= 6) {
      const salt = newSalt();
      await db.setSetting(dbx, 'admin_pass_salt', salt);
      await db.setSetting(dbx, 'admin_pass_hash', await pbkdf2(String(b.new_password), salt));
      await db.setSetting(dbx, 'admin_pass_iter', String(100000));
    }
    clearAll();   // 站点标题 / 主题色 / 导航开关… 每一页的页头页脚都可能变
    return json({ ok: true });
  }
  }

  // --- 友链管理 ---
  if (seg[0] === 'links') {
    if (method === 'GET' && seg.length === 1) {
      const status = url.searchParams.get('status') || 'all';
      const [items, counts] = await Promise.all([
        db.listLinks(dbx, { status }),
        db.countLinksByStatus(dbx),
      ]);
      return json({ items, counts });
    }
    if (method === 'POST' && seg.length === 1) {
      const b = (await readJson(request)) || {};
      const name = String(b.name || '').trim().slice(0, 40);
      const url = String(b.url || '').trim().slice(0, 300);
      if (!name) return err('请填写站点名称');
      if (!url) return err('请填写站点地址');
      if (!/^https?:\/\/[^\s]+$/i.test(url)) return err('网址需以 http:// 或 https:// 开头');
      const logo = String(b.logo || '').trim().slice(0, 300);
      if (logo && !/^https?:\/\/[^\s]+$/i.test(logo)) return err('图标地址需以 http:// 或 https:// 开头');
      const id = await db.addLink(dbx, {
        name, url, logo,
        description: String(b.description || '').trim().slice(0, 120),
        contact: String(b.contact || '').trim().slice(0, 80),
        reason: String(b.reason || '').trim().slice(0, 300),
        sort: Math.max(0, Math.min(9999, parseInt(b.sort, 10) || 0)),
        status: db.LINK_STATUS.includes(b.status) ? b.status : 'approved', // 博主自己加的，默认直接展示
        source: 'admin',
      });
      clearPaths(['/links']);
      return json({ ok: true, id });
    }
    if (seg.length === 2 && /^\d+$/.test(seg[1])) {
      const id = parseInt(seg[1], 10);
      if (method === 'PATCH') {
        const b = (await readJson(request)) || {};
        const patch = {};
        if (b.status != null) {
          if (!db.LINK_STATUS.includes(b.status)) return err('状态值不合法');
          patch.status = b.status;
        }
        ['name', 'url', 'description', 'logo', 'contact', 'reason'].forEach((k) => {
          if (b[k] != null) patch[k] = String(b[k]).trim().slice(0, k === 'url' || k === 'logo' ? 300 : 120);
        });
        if (patch.url && !/^https?:\/\/[^\s]+$/i.test(patch.url)) return err('网址需以 http:// 或 https:// 开头');
        if (patch.logo && !/^https?:\/\/[^\s]+$/i.test(patch.logo)) return err('图标地址需以 http:// 或 https:// 开头');
        if (b.sort != null) patch.sort = Math.max(0, Math.min(9999, parseInt(b.sort, 10) || 0));
        if (!Object.keys(patch).length) return err('没有要修改的字段');
        await db.updateLink(dbx, id, patch);
        clearPaths(['/links']);
        return json({ ok: true });
      }
      if (method === 'DELETE') {
        await db.deleteLink(dbx, id);
        clearPaths(['/links']);
        return json({ ok: true });
      }
    }
    return err('接口不存在', 404);
  }

  // --- 友圈订阅管理（Ver 0.4 ⑫）---
  if (seg[0] === 'feeds') {
    if (method === 'GET' && seg.length === 1) {
      const [items, total, lastAt] = await Promise.all([
        db.listFeeds(dbx),
        db.countFeeds(dbx),
        db.getSetting(dbx, 'friends_refresh_at', ''),
      ]);
      return json({ items, total, last_refresh: lastAt });
    }
    if (method === 'POST' && seg.length === 1) {
      const b = (await readJson(request)) || {};
      const url = String(b.url || '').trim().slice(0, 300);
      if (!url) return err('请填写 RSS 地址');
      if (!/^https?:\/\/\S+$/i.test(url)) return err('RSS 地址需以 http:// 或 https:// 开头');
      if (!feed.isFetchableUrl(url)) return err('这个地址不允许：只支持公网 http / https 地址');
      if (await db.findFeedByUrl(dbx, url)) return err('这个 RSS 地址已经订阅过了');
      const id = await db.addFeed(dbx, {
        name: String(b.name || '').trim().slice(0, 40),
        url,
        site_url: String(b.site_url || '').trim().slice(0, 300),
        avatar: String(b.avatar || '').trim().slice(0, 300),
        description: String(b.description || '').trim().slice(0, 120),
        sort: Math.max(0, Math.min(9999, parseInt(b.sort, 10) || 0)),
        enabled: b.enabled === false || b.enabled === 0 ? 0 : 1,
        // Ver 0.5 ⑤：默认**不进**白名单 —— 新订阅抓回来的文章先进待审，看过觉得合适再放行
        whitelist: b.whitelist === true || b.whitelist === 1 ? 1 : 0,
      });
      // 加完立刻抓一次：博主当场就知道成没成、抓到几篇，不用等下一个刷新周期
      const r = (await feed.refreshFeeds(env, { ids: [id], timeoutMs: 8000 }))[0] || {};
      const row = await db.getFeed(dbx, id);
      clearPaths(['/friends']);
      return json({
        ok: true, id,
        fetched: r.ok ? (r.count || 0) : 0,
        error: r.ok ? '' : (r.error || '抓取失败'),
        name: (row && row.name) || '',
        site_url: (row && row.site_url) || '',
      });
    }
    // 刷新：POST /api/feeds/refresh 刷全部，POST /api/feeds/<id>/refresh 刷单条
    if (method === 'POST' && seg.length === 2 && seg[1] === 'refresh') {
      const results = await feed.refreshFeeds(env, { limit: 20 });
      clearPaths(['/friends']);
      return json({ ok: true, results });
    }
    if (method === 'POST' && seg.length === 3 && /^\d+$/.test(seg[1]) && seg[2] === 'refresh') {
      const results = await feed.refreshFeeds(env, { ids: [parseInt(seg[1], 10)], limit: 1 });
      clearPaths(['/friends']);
      return json({ ok: !!(results[0] && results[0].ok), results });
    }
    if (seg.length === 2 && /^\d+$/.test(seg[1])) {
      const id = parseInt(seg[1], 10);
      const cur = await db.getFeed(dbx, id);
      if (!cur) return err('订阅不存在', 404);
      if (method === 'PATCH') {
        const b = (await readJson(request)) || {};
        const patch = {};
        if (b.name != null) patch.name = String(b.name).trim().slice(0, 40);
        ['site_url', 'avatar'].forEach((k) => {
          if (b[k] != null) patch[k] = String(b[k]).trim().slice(0, 300);
        });
        if (b.description != null) patch.description = String(b.description).trim().slice(0, 120);
        if (b.url != null) {
          const u = String(b.url).trim().slice(0, 300);
          if (!feed.isFetchableUrl(u)) return err('这个地址不允许：只支持公网 http / https 地址');
          const dup = await db.findFeedByUrl(dbx, u);
          if (dup && dup.id !== id) return err('这个 RSS 地址已经订阅过了');
          patch.url = u;
        }
        if (b.sort != null) patch.sort = Math.max(0, Math.min(9999, parseInt(b.sort, 10) || 0));
        if (b.enabled != null) patch.enabled = (b.enabled === false || b.enabled === 0) ? 0 : 1;
        if (b.whitelist != null) patch.whitelist = (b.whitelist === true || b.whitelist === 1) ? 1 : 0;
        if (!Object.keys(patch).length) return err('没有要修改的字段');
        await db.updateFeed(dbx, id, patch);
        // 刚被设为白名单：把它以前压着的待审文章一并放行 —— 设为白名单即认可这个源
        let passed = 0;
        if (patch.whitelist === 1 && !cur.whitelist) passed = await db.approveFeedPosts(dbx, id);
        // 换了地址就顺手重抓一次，免得列表里还挂着旧源的文章
        if (patch.url && patch.url !== cur.url) await feed.refreshFeeds(env, { ids: [id], timeoutMs: 8000 });
        clearPaths(['/friends']);
        return json({ ok: true, passed });
      }
      if (method === 'DELETE') {
        await db.deleteFeed(dbx, id);
        clearPaths(['/friends']);
        return json({ ok: true });
      }
    }
    return err('接口不存在', 404);
  }

  // --- 友圈文章审核（Ver 0.5 ⑤）---
  // 白名单源的文章抓回来直接上；不在白名单的源，文章先躺在 pending 里等这里点头。
  // 博主要么单条通过 / 忽略，要么整批处理。
  if (seg[0] === 'friendposts') {
    if (method === 'GET' && seg.length === 1) {
      const want = String(url.searchParams.get('status') || 'pending');
      const status = ['pending', 'approved', 'rejected'].includes(want) ? want : 'pending';
      const [items, counts] = await Promise.all([
        db.listFriendPostsAdmin(dbx, { status, limit: 60 }),
        db.countFriendPostsByStatus(dbx),
      ]);
      return json({ items, counts, status });
    }
    // 批量：{ ids:[...], status } 或 { all:true, status }（把当前所有待审一起处理）
    if (method === 'POST' && seg.length === 2 && seg[1] === 'batch') {
      const b = (await readJson(request)) || {};
      const status = String(b.status || '');
      if (!['approved', 'rejected', 'pending'].includes(status)) return err('状态不合法');
      const n = b.all === true
        ? await db.setAllPendingStatus(dbx, status)
        : await db.setFriendPostsStatus(dbx, b.ids, status);
      clearPaths(['/friends']);
      return json({ ok: true, changed: n });
    }
    // 批量删除：审核完不想留档的直接清掉（下次刷新会重新抓回来，除非把源暂停）
    if (method === 'POST' && seg.length === 2 && seg[1] === 'delete') {
      const b = (await readJson(request)) || {};
      const n = await db.deleteFriendPosts(dbx, b.ids);
      if (!n) return err('没有可删除的文章');
      clearPaths(['/friends']);
      return json({ ok: true, deleted: n });
    }
    if (seg.length === 2 && /^\d+$/.test(seg[1])) {
      const id = parseInt(seg[1], 10);
      if (method === 'PATCH') {
        const b = (await readJson(request)) || {};
        const status = String(b.status || '');
        if (!['approved', 'rejected', 'pending'].includes(status)) return err('状态不合法');
        if (!(await db.setFriendPostStatus(dbx, id, status))) return err('文章不存在', 404);
        clearPaths(['/friends']);
        return json({ ok: true });
      }
      if (method === 'DELETE') {
        if (!(await db.deleteFriendPosts(dbx, [id]))) return err('文章不存在', 404);
        clearPaths(['/friends']);
        return json({ ok: true });
      }
    }
    return err('接口不存在', 404);
  }

  // --- 分类管理 ---
  if (seg[0] === 'categories') {
    if (method === 'GET' && seg.length === 1) return json(await db.listCategories(dbx));
    if (method === 'POST' && seg.length === 1) {
      const b = (await readJson(request)) || {};
      const name = String(b.name || '').trim().slice(0, 30);
      if (!name) return err('请输入分类名称');
      // 别名只放行英文/数字/-：中文名会被 slugify 洗成空串，过去会悄悄变成 cat-123456 这种随机串，
      // 现在明确拒绝，让用户在后台自己填一个可读的别名
      const slugRaw = b.slug == null ? '' : String(b.slug).trim().slice(0, 60);
      if (slugRaw && !/^[a-zA-Z0-9-]+$/.test(slugRaw)) return err('别名只能用英文字母、数字和连字符 -');
      // 上级分类：只能挂在「顶级分类」下，只支持两级
      const pid = parseInt(b.parent_id, 10) || 0;
      if (pid) {
        const p = await dbx.prepare('SELECT id,parent_id FROM categories WHERE id=?').bind(pid).first();
        if (!p) return err('上级分类不存在');
        if (p.parent_id) return err('只支持两级分类：不能把分类挂在二级分类下面');
      }
      const r = await db.createCategory(dbx, { name, slug: slugRaw, description: String(b.description || '').slice(0, 200), parent_id: pid, in_nav: b.in_nav });
      clearAll();   // 分类可能出现在导航里
      return json({ ok: true, id: r.id, slug: r.slug, parent_id: r.parent_id, in_nav: r.in_nav });
    }
    if (seg.length === 2 && /^\d+$/.test(seg[1])) {
      const id = parseInt(seg[1], 10);
      if (method === 'PUT') {
        const b = (await readJson(request)) || {};
        const name = String(b.name || '').trim().slice(0, 30);
        if (!name) return err('请输入分类名称');
        const slugRaw = b.slug == null ? '' : String(b.slug).trim().slice(0, 60);
        if (slugRaw && !/^[a-zA-Z0-9-]+$/.test(slugRaw)) return err('别名只能用英文字母、数字和连字符 -');
        // parent_id 传 0 表示改回顶级；不传则保持原上级不变
        const pidRaw = b.parent_id;
        let pid;
        if (pidRaw === 0 || pidRaw === '0') pid = 0;
        else if (pidRaw == null || pidRaw === '') pid = null;   // null = 不动
        else pid = parseInt(pidRaw, 10) || 0;
        if (pid) {
          const p = await dbx.prepare('SELECT id,parent_id FROM categories WHERE id=?').bind(pid).first();
          if (!p) return err('上级分类不存在');
          if (p.parent_id) return err('只支持两级分类：不能把分类挂在二级分类下面');
          if (Number(p.id) === Number(id)) return err('上级不能是它自己');
        }
        const slug = await db.updateCategory(dbx, id, { name, slug: slugRaw, description: String(b.description || '').slice(0, 200), parent_id: pid, in_nav: b.in_nav });
        clearAll();
        return json({ ok: true, slug });
      }
      if (method === 'DELETE') {
        await db.deleteCategory(dbx, id);
        clearAll();
        return json({ ok: true });
      }
    }
    return err('接口不存在', 404);
  }

  // --- 标签管理（改名请直接在文章编辑页调整） ---
  if (seg[0] === 'tags') {
    if (method === 'GET' && seg.length === 1) return json(await db.listTags(dbx));
    if (seg.length === 2 && /^\d+$/.test(seg[1])) {
      const id = parseInt(seg[1], 10);
      if (method === 'PUT') return err('标签改名请在文章编辑页中调整', 400);
      if (method === 'DELETE') {
        await db.deleteTag(dbx, id);
        clearAll();
        return json({ ok: true });
      }
    }
    return err('接口不存在', 404);
  }

  // --- 文章置顶（Ver 0.4 ⑪）---
  // action：toggle 置顶／取消 | up 上移一位 | down 下移一位
  // 只回一个调整后的置顶顺序，前端据此重排即可，不必自己算优先级数字。
  if (seg[0] === 'pin' && method === 'POST' && seg.length === 1) {
    const b = (await readJson(request)) || {};
    const id = parseInt(b.id, 10);
    if (!Number.isInteger(id) || id <= 0) return err('缺少文章 id');
    const r = await db.pinPost(dbx, id, String(b.action || 'toggle'));
    if (!r.ok) return err(r.error, r.code || 400);
    clearPaths(['/', '/archive', '/categories', '/tags']);
    return json({ ok: true, pinned: r.list, moved: r.moved !== false });
  }

  // --- 文章管理 ---
  if (seg[0] === 'posts') {
    // 列表 GET /api/posts
    if (method === 'GET' && seg.length === 1) {
      const status = String(url.searchParams.get('status') || 'published');
      if (status !== 'published' && !user) return err('未登录', 401);
      const data = await db.listPosts(dbx, {
        status,
        // 默认只给文章；后台「页面」菜单传 type=page，互不干扰
        type: String(url.searchParams.get('type') || 'post'),
        q: url.searchParams.get('q') || '',
        cat: url.searchParams.get('cat') || undefined,
        tag: url.searchParams.get('tag') || undefined,
        page: parseInt(url.searchParams.get('page'), 10) || 1,
        per: Math.min(100, parseInt(url.searchParams.get('per'), 10) || 20),
      });
      // 带上按当前永久链接规则算出的地址，后台列表直接展示，不必再拼 /post/:slug
      const sm = await db.settingsMap(dbx);
      data.items = data.items.map((p) => ({ ...p, url: p.type === 'page' ? pageUrl(p) : postUrl(sm, p) }));
      // 未登录一律不带密码：这个接口 status=published 是公开的，带出去等于把锁拆了
      if (!user) data.items.forEach((p) => { delete p.password; });
      return json(data);
    }
    // 新建 POST /api/posts
    if (method === 'POST' && seg.length === 1) {
      const body = (await readJson(request)) || {};
      const title = String(body.title || '').trim();
      const contentMd = String(body.content_md || '');
      if (!title) return err('请填写文章标题');
      if (!contentMd.trim()) return err('请填写文章内容');
      const status = body.status === 'published' ? 'published' : 'draft';
      const contentHtml = render(contentMd);
      let excerpt = String(body.excerpt || '').trim().slice(0, 300);
      if (!excerpt) excerpt = stripHtml(contentHtml).slice(0, 180);
      const id = await db.createPost(dbx, {
        title, slug: body.slug, status,
        type: body.type === 'page' ? 'page' : 'post',
        in_nav: body.in_nav,   // 未传时 db 层默认 1（导航显示）
        password: body.password,   // 未传＝不加密；页面不加密
        category_id: body.category_id ? parseInt(body.category_id, 10) : null,
        content_md: contentMd, content_html: contentHtml, excerpt,
        cover_key: body.cover_key || null, tags: Array.isArray(body.tags) ? body.tags : [],
      });
      const post = await db.getPost(dbx, { id });
      if (status === 'published') {
        const sm = await db.settingsMap(dbx);
        clearForPost(post, sm);
        seoPush(post, sm);
      }
      return json({ ok: true, id, slug: post.slug });
    }
    // 单篇操作 GET/PUT/DELETE /api/posts/:id
    if (seg.length === 2 && /^\d+$/.test(seg[1])) {
      const id = parseInt(seg[1], 10);
      const post = await db.getPost(dbx, { id });
      if (!post) return err('文章不存在', 404);
      // 密码只有文章编辑器会传（未勾选＝空串＝取消加密）；不传就不动已有密码
      if (method === 'GET') {
        const out = { ...post, url: post.type === 'page' ? pageUrl(post) : postUrl(await db.settingsMap(dbx), post) };
        if (!user) delete out.password;
        return json(out);
      }
      if (method === 'DELETE') {
        // 回收站（Ver 0.7 ⑪）：删除只是打一个时间戳，评论 / 标签 / 别名 / 发布时间全部原样留着，
        // 所以「还原」不需要重拼任何关系。真要删干净走 /purge 或清空回收站。
        const ok = await db.trashPost(dbx, id);
        if (!ok) return err('文章不存在', 404);
        clearForPost(post, await db.settingsMap(dbx));
        return json({ ok: true, trashed: true });
      }
      if (method === 'PUT') {
        const body = (await readJson(request)) || {};
        const title = String(body.title || '').trim();
        const contentMd = String(body.content_md || '');
        if (!title) return err('请填写文章标题');
        if (!contentMd.trim()) return err('请填写文章内容');
        const status = body.status === 'published' ? 'published' : 'draft';
        const contentHtml = render(contentMd);
        let excerpt = String(body.excerpt || '').trim().slice(0, 300);
        if (!excerpt) excerpt = stripHtml(contentHtml).slice(0, 180);
        await db.updatePost(dbx, id, {
          title, slug: body.slug, status,
          // type / in_nav 只在显式传了才改：文章编辑不传，就不会被误改成页面
          ...(body.type ? { type: body.type === 'page' ? 'page' : 'post' } : {}),
          ...(body.in_nav != null ? { in_nav: body.in_nav ? 1 : 0 } : {}),
          ...(body.password != null ? { password: body.password } : {}),
          category_id: body.category_id ? parseInt(body.category_id, 10) : null,
          content_md: contentMd, content_html: contentHtml, excerpt,
          cover_key: body.cover_key || null,
          tags: Array.isArray(body.tags) ? body.tags : [],
        });
        const np = await db.getPost(dbx, { id });
        const sm = await db.settingsMap(dbx);
        clearForPost(np, sm);
        seoPush(np, sm);
        return json({ ok: true, slug: np.slug });
      }
    }
    // 发布 / 下线
    if (seg.length === 3 && seg[2] === 'publish' && method === 'POST') {
      const id = parseInt(seg[1], 10);
      const b = (await readJson(request)) || {};
      if (!['published', 'draft'].includes(b.status)) return err('非法状态');
      const ok = await db.setPostStatus(dbx, id, b.status);
      if (!ok) return err('文章不存在', 404);
      const np = await db.getPost(dbx, { id });
      const sm = await db.settingsMap(dbx);
      clearForPost(np, sm);
      seoPush(np, sm);
      return json({ ok: true, status: b.status });
    }
    // 回收站：还原 / 彻底删除（Ver 0.7 ⑪）
    // 两条都必须排在 GET/PUT/DELETE /api/posts/:id 之外 —— 那个分支只看 seg.length===2，
    // 这里是 3，不会互相吞。
    if (seg.length === 3 && /^\d+$/.test(seg[1]) && (seg[2] === 'restore' || seg[2] === 'purge')) {
      const id = parseInt(seg[1], 10);
      // 单篇读取要绕过「排除回收站」的默认：否则一条都不可能找到，还原永远 404
      const gone = await db.getPost(dbx, { id, withDeleted: true });
      if (!gone) return err('文章不存在', 404);
      if (!gone.deleted_at) return err('这篇不在回收站里', 400);
      const sm = await db.settingsMap(dbx);
      if (seg[2] === 'restore') {
        if (method !== 'POST') return err('接口不存在', 404);
        const ok = await db.restorePost(dbx, id);
        if (!ok) return err('还原失败，请刷新后重试', 409);
        const back = await db.getPost(dbx, { id });
        clearForPost(back, sm);
        // 把最终别名回传：极端情况下还原时别名已被占，会自动加序号，前端要能提示
        return json({ ok: true, restored: true, slug: back ? back.slug : gone.slug, type: gone.type });
      }
      if (method !== 'POST' && method !== 'DELETE') return err('接口不存在', 404);
      await db.deletePost(dbx, id);
      clearForPost(gone, sm);
      return json({ ok: true, purged: true });
    }
    return err('接口不存在', 404);
  }
  // --- 回收站（Ver 0.7 ⑪）---
  if (seg[0] === 'trash') {
    // 列表：文章与页面一起给，按删除时间倒序（与后台「文章 / 页面」两个列表分开的口径不同）
    if (method === 'GET' && seg.length === 1) {
      const type = String(url.searchParams.get('type') || 'all');
      const data = await db.listPosts(dbx, {
        status: 'all',   // 回收站里已发布与草稿混在一起，状态只做展示，不做筛选
        type: type === 'post' || type === 'page' ? type : 'all',
        deleted: 'only',
        page: parseInt(url.searchParams.get('page'), 10) || 1,
        per: Math.min(100, parseInt(url.searchParams.get('per'), 10) || 30),
      });
      const sm = await db.settingsMap(dbx);
      data.items = data.items.map((p) => ({
        ...p,
        // 地址照常算出来，后台「查看」按钮据此判断能不能点（回收站里的一律不给查看）
        url: p.type === 'page' ? pageUrl(p) : postUrl(sm, p),
      }));
      return json(data);
    }
    // 清空：整个回收站唯一一条一次删多篇、且不可撤销的接口，必须带 confirm:'empty'。
    // 不传或传别的值一律拒绝 —— 默认值要落在「不动数据」那一侧。
    if (method === 'POST' && seg.length === 2 && seg[1] === 'empty') {
      const b = (await readJson(request)) || {};
      if (b.confirm !== 'empty') return err('请确认清空回收站', 400);
      const type = b.type === 'post' || b.type === 'page' ? b.type : '';
      const n = await db.emptyTrash(dbx, { type });
      // 一次删多篇，受影响路径说不全 → 整站缓存一起清（页面不多时比逐个算便宜）
      clearAll();
      return json({ ok: true, removed: n });
    }
    return err('接口不存在', 404);
  }
  if (seg[0] === 'admin' && seg[1] === 'comments' && seg.length === 2 && method === 'GET') {
    const status = String(url.searchParams.get('status') || 'pending');
    const items = await db.listComments(dbx, { status, limit: 300 });
    // 旧评论外链降级（Ver 0.6 ⑩）：后台列表标一个「外链已停用」，方便博主核对
    // 到底哪些留言被降级了。这里和前台渲染调的是同一个 linkDowngraded()，
    // 不各算一套年龄规则。读设置失败就只是不显示徽标，不影响评论列表。
    try {
      const linkS = await db.settingsMap(dbx);
      for (const c of items) c.link_off = site.linkDowngraded(linkS, c) ? 1 : 0;
    } catch (e) { /* 忽略 */ }
    // 归属地：缓存里有的直接贴上；没有的这一次请求顺手补一批（上限 GEO_SYNC_MAX），
    // 补不完的报给前端，由博主决定要不要继续催（POST /api/ipgeo/sync）。
    // 整段包 try：归属地只是评论旁边的一行小字，绝不能因为它导致评论列表打不开。
    let geoMiss = 0;
    try {
      if (await geoOn()) {
        const m = await ipgeo.geoMap(dbx, items.map((c) => c.ip));
        const seen = new Set();
        const todo = [];
        for (const c of items) {
          const key = String(c.ip || '').trim();
          const g = m.get(key);
          if (g) { c.geo_loc = g.loc; c.geo_isp = g.isp; continue; }
          if (ipgeo.isPublicIp(key) && !seen.has(key)) { seen.add(key); todo.push(key); }
        }
        geoMiss = todo.length;
        const batch = todo.slice(0, GEO_SYNC_MAX);
        if (batch.length) {
          await ipgeo.geoSync(dbx, batch, await geoProvider(), { timeout: 2500 });
          const m2 = await ipgeo.geoMap(dbx, batch);
          for (const c of items) {
            if (c.geo_loc != null) continue;
            const g = m2.get(String(c.ip || '').trim());
            if (g) { c.geo_loc = g.loc; c.geo_isp = g.isp; }
          }
          // 报「补齐之后还差多少」，不是「这次进来时缺多少」——
          // 前端显示的数字就是还要点几次「继续补齐」，一眼看得出有没有进展。
          // 用补完仍然空的去重 IP 数，接口临时失败的那些也会被正确算进来。
          const left = new Set();
          for (const c of items) {
            if (c.geo_loc != null) continue;
            const key = String(c.ip || '').trim();
            if (ipgeo.isPublicIp(key)) left.add(key);
          }
          geoMiss = left.size;
        }
      }
    } catch (e) { /* 归属地拿不到不影响列表 */ }
    return json({ items, status, geo_missing: geoMiss });
  }
  if (seg[0] === 'comments' && seg.length === 2 && /^\d+$/.test(seg[1])) {
    const id = parseInt(seg[1], 10);
    if (method === 'PATCH') {
      const b = (await readJson(request)) || {};
      if (!['pending', 'approved', 'trash'].includes(b.status)) return err('非法状态');
      await db.setCommentStatus(dbx, id, b.status);
      await clearForComment(id);
      return json({ ok: true });
    }
    if (method === 'DELETE') {
      await clearForComment(id);   // 删除前先取所属文章，删完就查不到了
      await db.deleteComment(dbx, id);
      return json({ ok: true });
    }
  }
  // 博主回复 POST /api/comments/:id/reply
  if (seg[0] === 'comments' && seg.length === 3 && seg[2] === 'reply' && method === 'POST') {
    const id = parseInt(seg[1], 10);
    const b = (await readJson(request)) || {};
    const content = String(b.content || '').trim();
    if (content.length < 2 || content.length > 2000) return err('回复内容需在 2–2000 字之间');
    const parent = await db.getComment(dbx, id);
    if (!parent) return err('评论不存在', 404);
    await db.addComment(dbx, {
      postId: parent.post_id, parentId: parent.id,
      author: (await db.getSetting(dbx, 'author_name')) || '博主',
      email: '', content, status: 'approved', isAdmin: 1, ip: '',
    });
    if (purge.ready(env)) {
      const pp = await db.getPost(dbx, { id: parent.post_id });
      if (pp) clearPaths([postUrl(await db.settingsMap(dbx), pp)]);
    }
    ctx.waitUntil(notifyReply(dbx, url.origin, parent, content));
    return json({ ok: true });
  }

  // --- 邮件通知：发一封测试邮件验证配置（登录） ---
  if (seg[0] === 'mail' && seg[1] === 'test' && method === 'POST' && seg.length === 2) {
    if (!(await authUser())) return err('未登录', 401);
    const s = await db.settingsMap(dbx);
    // 页面上的参数可能还没保存：允许前端把当前表单值带过来，测的就是眼睛看到的那一套。
    // 否则会出现「页面显示 465、实际测的是库里的 587」—— 报错信息跟页面对不上，无从排查
    // （Wei 就踩过：库里存了 163 不支持的 587，页面已自动改成 465，测试却仍打 587 然后报 220 被断）。
    const b = (await readJson(request)) || {};
    const cfg = mailConfigFrom(s);
    if (b.mail_host != null) cfg.host = String(b.mail_host).trim();
    if (b.mail_port != null) cfg.port = parseInt(b.mail_port, 10) || cfg.port;
    if (b.mail_secure != null) cfg.secure = String(b.mail_secure) === 'starttls' ? 'starttls' : 'ssl';
    if (b.mail_user != null) cfg.user = String(b.mail_user).trim();
    if (b.mail_pass != null && String(b.mail_pass) !== '') cfg.pass = String(b.mail_pass);
    // 服务商没开这个端口就直接说清楚，别去连一次再拿「被提前关闭」这种无法行动的错误
    const pi = mailPortIssue(cfg);
    if (pi) return err(pi, 400);
    const ce = mailConfigError(cfg);
    if (ce) return err('配置不完整：' + ce, 400);
    const to = (s.get('email') || '').trim();
    if (!to) return err('请先在「设置 → 安全设置」填写博主邮箱：测试邮件会发到这个地址', 400);
    // 用 400 而不是 502：5xx 的响应体可能被 Cloudflare 换成自己的错误页，
    // 前端就只能看到「请求失败 (502)」而拿不到 SMTP 的真实原因。
    try {
      const m = renderMail(cfg.template, {
        kind: 'comment', site: s.get('site_title') || '博客', siteUrl: url.origin,
        postTitle: '邮件通知测试', postUrl: url.origin, adminUrl: url.origin + '/admin#/settings/comment',
        author: '系统', content: '这是一封测试邮件。收到它说明 SMTP 配置正确，评论通知可以正常工作。', pending: false,
      });
      const r = await sendMailWithTimeout(cfg, { to, subject: m.subject, text: m.text, html: m.html }, connect);
      // 把实际连接参数一并回传：页面显示的值与库里的值可能不一致（改了没保存等），
      // 报错时带上它能立刻判断到底是「配错了」还是「服务器拒绝了」。
      const used = describeCfg(cfg);
      return r.ok ? json({ ok: true, to, used }) : err(`发送失败：${r.error}｜实际连接 ${used}`, 400);
    } catch (e) {
      return err('发送出错：' + ((e && e.message) || e), 400);
    }
  }

  return err('接口不存在', 404);
}

// ============================================================
// 邮件通知：任何失败都只记日志，绝不影响评论 / 回复本身的结果
// （SMTP 可能不通、博主邮箱可能没填，这些都不该让读者提交失败）
// ============================================================
async function notifyNewComment(dbx, origin, post, c) {
  try {
    const s = await db.settingsMap(dbx);
    const cfg = mailConfigFrom(s);
    if (!cfg.enabled || !cfg.onComment) return;
    const to = (s.get('email') || '').trim();
    if (!to) return;
    const ce = mailConfigError(cfg);
    if (ce) { console.error('mail skip:', ce); return; }
    const m = renderMail(cfg.template, {
      kind: 'comment',
      site: s.get('site_title') || '博客',
      siteUrl: origin,
      postTitle: post.title || '',
      postUrl: origin + postUrl(s, post),
      adminUrl: origin + '/admin#/comments',
      author: c.author, email: c.email, content: c.content,
      pending: c.status === 'pending',
    });
    const r = await sendMailWithTimeout(cfg, { to, subject: m.subject, text: m.text, html: m.html }, connect);
    if (!r.ok) console.error('mail fail:', r.error);
  } catch (e) { console.error('mail error:', (e && e.message) || e); }
}

async function notifyReply(dbx, origin, parent, content) {
  try {
    const s = await db.settingsMap(dbx);
    const cfg = mailConfigFrom(s);
    if (!cfg.enabled || !cfg.onReply) return;
    const to = (parent.email || '').trim();
    // 回复博主自己的评论时没有收件人，直接跳过
    if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return;
    const ce = mailConfigError(cfg);
    if (ce) { console.error('mail skip:', ce); return; }
    const post = await db.getPost(dbx, { id: parent.post_id });
    const m = renderMail(cfg.template, {
      kind: 'reply',
      site: s.get('site_title') || '博客',
      siteUrl: origin,
      postTitle: (post && post.title) || '',
      postUrl: post ? origin + postUrl(s, post) : origin,
      adminUrl: origin + '/admin#/comments',
      author: s.get('author_name') || '博主',
      content,
      pending: false,
    });
    const r = await sendMailWithTimeout(cfg, { to, subject: m.subject, text: m.text, html: m.html }, connect);
    if (!r.ok) console.error('mail fail:', r.error);
  } catch (e) { console.error('mail error:', (e && e.message) || e); }
}

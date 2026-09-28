// ============================================================
// Pages Functions 唯一入口（catch-all）
// 负责：/api/* 接口、/media/* R2 图片代理、前台页面 SSR、
//       rss.xml / sitemap.xml / robots.txt、后台静态资源(经 ASSETS)
// ============================================================
import { json, err, esc, bnNow, readJson, mimeOfExt, isHexColor, isEmail, stripHtml, wantsFeedHtml, readCookie, newVisitorId, hitGuard,
  normalizePermalink, permalinkOf, permalinkRegex, postUrl, pageUrl, catUrl, permalinkVarsMatch,
  sha256Hex, safeEqual, postPassCookie } from './_lib/util.js';
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
import { ADMIN_SHELL } from './_lib/admin-shell.js';
import { newSalt, pbkdf2, userFromRequest, makeSessionValue, setSessionCookie, clearSessionCookie } from './_lib/auth.js';
import { newCaptcha, checkCaptcha, clearCaptchaCookie } from './_lib/captcha.js';

// 携带 Set-Cookie 的 JSON 响应
const jset = (data, cookie, status = 200) => {
  const r = json(data, status);
  if (cookie) r.headers.set('Set-Cookie', cookie);
  return r;
};

// 友圈（Ver 0.4 ⑫）：前台访问 /friends 时，若距上次抓取超过这个分钟数，
// 就用 waitUntil 在后台补一轮 —— 访客不等抓取，但数据会自己变新。
const FRIEND_TTL_MIN = 30;
const FRIEND_PER_PAGE = 20;

export async function onRequest(ctx) {
  try {
    return await handle(ctx);
  } catch (e) {
    console.error('route error:', e);
    return err('服务器内部错误：' + e.message, 500);
  }
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

  // ---- 后台静态资源与根静态文件 ----
  // （/media、/backup、robots/rss/sitemap 等动态路径需排除，避免被扩展名规则截胡）
  const isDynamicExt = seg[0] === 'media' || seg[0] === 'backup' || seg[0] === 'backups' || seg[0] === 'theme-assets'
    || ['rss.xml', 'feed.xml', 'sitemap.xml', 'robots.txt'].includes(path.slice(1)) || path === '/favicon.svg';
  if (seg[0] === 'admin' || (STATIC_EXT.test(path) && !isDynamicExt) || path === '/favicon.ico') {
    const target = new URL(request.url);
    if (seg[0] === 'admin' && seg.length === 1) {
      // 规范化为目录 URL（/admin → /admin/）交给静态层服务 index.html。
      // ⚠️ 不能改写成 /admin/index.html：Pages 平台硬编码会把 xxx/index.html 请求
      // 308 重定向回 xxx/，而 /admin 又在 catch-all 内，形成 308 死循环（"重定向过多"）。
      if (!path.endsWith('/')) target.pathname += '/';
    }
    return env.ASSETS.fetch(new Request(target, request));
  }

  // ---- R2 图片代理 ----
  if (seg[0] === 'media') {
    if (method !== 'GET' && method !== 'HEAD') return err('方法不允许', 405);
    const key = 'media/' + seg.slice(1).join('/');
    const obj = await env.BLOG.get(key);
    if (!obj) return err('图片不存在', 404);
    const ct = obj.httpMetadata?.contentType || obj.customMetadata?.ct || mimeOfExt(key);
    return new Response(obj.body, {
      headers: {
        'content-type': ct,
        'cache-control': 'public, max-age=31536000, immutable',
        'etag': obj.httpEtag || '',
      },
    });
  }

  // ---- 主题静态资源代理（R2 themes/ 前缀；CSS 内的相对 url() 也走这里） ----
  if (seg[0] === 'theme-assets') {
    if (method !== 'GET' && method !== 'HEAD') return err('方法不允许', 405);
    const rel = seg.slice(1);
    if (!rel.length || rel.some((x) => x === '..' || x === '.' || x.includes('\\'))) return err('非法路径', 400);
    const key = 'themes/' + rel.join('/');
    const obj = await env.BLOG.get(key);
    if (!obj) return err('资源不存在', 404);
    const ct = obj.httpMetadata?.contentType || obj.customMetadata?.ct || mimeOfExt(key);
    return new Response(obj.body, {
      headers: {
        'content-type': ct,
        'cache-control': 'public, max-age=300',
        'etag': obj.httpEtag || '',
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
  // 其余前台路径（首页 / page / category|categories / tag|tags / archive / links /
  // friends / p 独立页 / 文章永久链接）输出对所有人一致，可缓存
  return true;
}

// 前台入口：匿名请求先看边缘缓存，命中直接返回，完全不碰 D1 与渲染。
// 一页能不能进公共缓存：状态 200、这条路线对所有人输出一致，
// 且渲染没主动挂 x-cache:0 否决自己（如加密文章的「密码错误」页）
const SHARED = (seg, r) => r.status === 200 && sharedPath(seg) && r.headers.get('x-cache') !== '0';

async function serveFront(ctx, url, seg, method, path) {
  const anon = cache.canCache(ctx.request);
  if (anon) {
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
  if (!anon || vetoed) {
    // 因人而异（登录态 / 加密文章解锁态），或渲染明确要求不缓存：
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
  const per = Math.min(20, Math.max(1, parseInt(s.get('per_page'), 10) || 8));
  const user = await userFromRequest(env, ctx.request);
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
      return `<article class="pc${cover ? '' : ' no-cover'}"><div>
        <div class="pc-meta"><time>${esc(p.published_at || '').slice(0, 10)}</time><span class="dot">·</span><span>阅读 ${p.view_count || 0}</span></div>
        <h2 class="pc-title">${site.pinBadge(p)}<a href="${u}">${esc(p.title)}</a></h2>
        ${p.excerpt ? `<p class="pc-excerpt">${esc(p.excerpt)}</p>` : ''}
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
    : (p.excerpt ? `<p class="pc-excerpt">${esc(p.excerpt)}</p>` : '')}</div></article>`).join('');
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
    // 免审评论会立刻出现在文章页上：把那一页的缓存清掉，别让读者刚发的评论「看不见」
    if (!audit && purge.ready(env)) clearPaths([postUrl(await db.settingsMap(dbx), post)]);
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

  // --- 媒体（R2） ---
  if (seg[0] === 'media') {
    if (method === 'POST' && seg.length === 1) {
      const ctRaw = request.headers.get('content-type') || '';
      const ct = ctRaw.split(';')[0].trim().toLowerCase();
      const allow = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'image/bmp': 'bmp', 'image/x-icon': 'ico' };
      const ext = allow[ct];
      if (!ext) return err('仅支持 PNG / JPG / GIF / WebP / AVIF / BMP 图片', 415);
      const len = parseInt(request.headers.get('content-length') || '0', 10);
      if (len > 8 * 1024 * 1024) return err('图片不能超过 8MB', 413);
      const key = `media/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      await env.BLOG.put(key, request.body, { httpMetadata: { contentType: ct }, customMetadata: { ct } });
      return json({ ok: true, key, url: '/media/' + key });
    }
    if (method === 'GET' && seg.length === 1) {
      const list = await env.BLOG.list({ prefix: 'media/', cursor: url.searchParams.get('cursor') || undefined, limit: 200 });
      return json({
        items: (list.objects || []).map((o) => ({
          key: o.key, size: o.size, uploaded: o.uploaded,
          ct: o.customMetadata?.ct || mimeOfExt(o.key),
          url: '/media/' + o.key,
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

  // --- 备份（R2） ---
  // 说明：路由是单数 /api/backup；'backups' 作为别名保留，兼容旧版前端的复数写法
  if (seg[0] === 'backup' || seg[0] === 'backups') {
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
      return json({ items: all.sort((a, b) => b.uploaded - a.uploaded).map((o) => ({ key: o.key, size: o.size, uploaded: o.uploaded, name: o.key.split('/').pop() })) });
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
      const list = await env.BLOG.list({ prefix: 'themes/', limit: 1000 });
      const ids = new Set();
      for (const o of list.objects || []) {
        const m = /^themes\/([^/]+)\//.exec(o.key);
        if (m) ids.add(m[1]);
      }
      for (const id of [...ids].sort()) {
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
      const css = await env.BLOG.get('themes/' + id + '/style.css');
      if (!css) return err('主题不存在或缺少 style.css', 404);
      await db.setSetting(dbx, 'active_theme', id);
      clearAll();
      return json({ ok: true, active: id });
    }

    // DELETE /api/themes/:id —— 删除主题文件；若正被启用则自动回退内置默认
    if (method === 'DELETE' && seg.length === 2) {
      const id = String(seg[1]).toLowerCase().replace(/[^a-z0-9-]+/g, '').slice(0, 40);
      if (!id || id === 'default') return err('内置主题不可删除', 400);
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
    const nOf = (r) => (r && r.n) || 0;
    const [st, pending, recent, cmts, top, mPosts, mCmts, words, views, pv, linkCnt, linkPending, sm] = await Promise.all([
      db.stats(dbx),
      db.listComments(dbx, { status: 'pending', limit: 5 }),
      // 「最近文章」语义上就是按时间排，置顶不该插进来（pinFirst:false）
      db.listPosts(dbx, { status: 'all', per: 6, pinFirst: false }),
      db.listComments(dbx, { status: 'all', limit: 6 }),
      dbx.prepare(`SELECT p.id,p.title,p.slug,p.view_count,p.published_at,c.slug AS cat_slug FROM posts p
                   LEFT JOIN categories c ON c.id=p.category_id WHERE p.status='published'
                   ORDER BY p.view_count DESC, p.id DESC LIMIT 5`).all(),
      dbx.prepare(`SELECT COUNT(*) n FROM posts WHERE created_at>=?`).bind(monthStart).first(),
      dbx.prepare(`SELECT COUNT(*) n FROM comments WHERE created_at>=?`).bind(monthStart).first(),
      // 字数按 Markdown 源码统计：SQLite 的 length() 对文本返回字符数（不是字节），中文不会被放大 3 倍
      dbx.prepare(`SELECT COALESCE(SUM(LENGTH(content_md)),0) n FROM posts`).first(),
      dbx.prepare(`SELECT COALESCE(SUM(view_count),0) n FROM posts`).first(),
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
      delete all.admin_pass_hash;
      delete all.admin_pass_salt;
      delete all.admin_pass_iter;
      delete all.mail_pass;
      all.mail_pass_set = hasPass ? '1' : '0';
      if (!(await authUser())) delete all.email;
      return json(all);
    }
    if (method === 'PATCH' && seg.length === 1) {
    const b = (await readJson(request)) || {};
    // 永久链接先校验再写：不合法直接拒，避免落一半字段；空串表示恢复默认
    if (b.permalink != null) {
      const pm = normalizePermalink(b.permalink);
      if (!pm) return err('永久链接格式不合法：需以 / 开头且包含 {slug} 或 {id}，可用变量 {year} {month} {day} {category}');
      await db.setSetting(dbx, 'permalink', pm);
    }
    // 博主邮箱同先校验后写：留空表示清除，填了必须是合法格式（不验证是否真实存在）
    if (b.email != null) {
      const em = String(b.email).trim();
      if (em && !isEmail(em)) return err('邮箱格式不正确（示例：name@example.com）');
      await db.setSetting(dbx, 'email', em.slice(0, 120));
    }
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
    // 图标地址：只接受站内相对路径或 http(s)，挡掉 javascript: 等伪协议；传空串表示清除
    const safeUrl = (v) => (/^(https?:\/\/|\/)/i.test(String(v || '').trim()) ? String(v).trim().slice(0, 300) : '');
    if (b.logo_image != null) await db.setSetting(dbx, 'logo_image', safeUrl(b.logo_image));
    if (b.favicon_image != null) await db.setSetting(dbx, 'favicon_image', safeUrl(b.favicon_image));
    if (b.per_page != null) await db.setSetting(dbx, 'per_page', String(Math.min(20, Math.max(1, parseInt(b.per_page, 10) || 8))));
    if (b.allow_comments != null) await db.setSetting(dbx, 'allow_comments', b.allow_comments ? '1' : '0');
    if (b.comment_audit != null) await db.setSetting(dbx, 'comment_audit', b.comment_audit ? '1' : '0');
    if (b.captcha != null) await db.setSetting(dbx, 'captcha', b.captcha ? '1' : '0');
    // ---- 导航栏显示开关：关掉只是不出现在页头导航，页面地址照常可访问 ----
    for (const k of ['categories', 'tags', 'archive', 'links', 'rss']) {
      if (b['nav_show_' + k] != null) await db.setSetting(dbx, 'nav_show_' + k, b['nav_show_' + k] ? '1' : '0');
    }
    // ---- 全站灰度：默认关，启用后整站转灰（优先级高于主题） ----
    if (b.gray_mode != null) await db.setSetting(dbx, 'gray_mode', b.gray_mode ? '1' : '0');
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
        if (!Object.keys(patch).length) return err('没有要修改的字段');
        await db.updateFeed(dbx, id, patch);
        // 换了地址就顺手重抓一次，免得列表里还挂着旧源的文章
        if (patch.url && patch.url !== cur.url) await feed.refreshFeeds(env, { ids: [id], timeoutMs: 8000 });
        clearPaths(['/friends']);
        return json({ ok: true });
      }
      if (method === 'DELETE') {
        await db.deleteFeed(dbx, id);
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
      if (status === 'published') clearForPost(post, await db.settingsMap(dbx));
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
        await db.deletePost(dbx, id);
        clearForPost(post, await db.settingsMap(dbx));
        return json({ ok: true });
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
        clearForPost(np, await db.settingsMap(dbx));
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
      clearForPost(await db.getPost(dbx, { id }), await db.settingsMap(dbx));
      return json({ ok: true, status: b.status });
    }
    return err('接口不存在', 404);
  }
  if (seg[0] === 'admin' && seg[1] === 'comments' && seg.length === 2 && method === 'GET') {
    const status = String(url.searchParams.get('status') || 'pending');
    return json({ items: await db.listComments(dbx, { status, limit: 300 }), status });
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

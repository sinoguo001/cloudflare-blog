// ============================================================
// Pages Functions 唯一入口（catch-all）
// 负责：/api/* 接口、/media/* R2 图片代理、前台页面 SSR、
//       rss.xml / sitemap.xml / robots.txt、后台静态资源(经 ASSETS)
// ============================================================
import { json, err, esc, bnNow, readJson, mimeOfExt, isHexColor, stripHtml, wantsFeedHtml } from './_lib/util.js';
import { render } from './_lib/md.js';
import { CODE_THEMES } from './_lib/hl.js';
import * as db from './_lib/db.js';
import * as site from './_lib/site.js';
import { ADMIN_SHELL } from './_lib/admin-shell.js';
import { newSalt, pbkdf2, userFromRequest, makeSessionValue, setSessionCookie, clearSessionCookie } from './_lib/auth.js';
import { newCaptcha, checkCaptcha, clearCaptchaCookie } from './_lib/captcha.js';

// 携带 Set-Cookie 的 JSON 响应
const jset = (data, cookie, status = 200) => {
  const r = json(data, status);
  if (cookie) r.headers.set('Set-Cookie', cookie);
  return r;
};

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
  // 动态 favicon：与页头 logo 同源（同字同色），改站点名或主题色自动跟随；
  // 后台若上传了自定义 favicon / logo，页面 link 会直接指向图片，不再走这里。
  if (path === '/favicon.svg') {
    const s = await db.settingsMap(env.DB);
    return new Response(site.faviconSvg(s), {
      headers: { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'public, max-age=3600' },
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

  // ---- 其余全部交给前台渲染 ----
  return front(ctx, url, seg, method, path);
}

// ============ 前台页面 ============
const html = (str, status = 200) =>
  new Response(str, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });

async function front(ctx, url, seg, method, path) {
  const { env } = ctx;
  const s = await db.settingsMap(env.DB);
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

  // 文章页 /post/:slug（草稿仅登录可见）
  if (seg[0] === 'post' && seg[1] && seg.length === 2) {
    const slug = seg[1];
    const post = await db.getPost(env.DB, { slug });
    if (!post || (post.status !== 'published' && !user)) return html(site.render404(s), 404);
    if (post.status !== 'published' && user) {
      post.content_html = `<div class="empty" style="padding:14px;margin-bottom:14px">此文章为<b>草稿</b>，仅你可见 · <a href="/admin#/posts/${post.id}">回后台编辑</a></div>` + post.content_html;
    }
    const [siblings, comments, cfg] = await Promise.all([
      db.siblings(env.DB, post),
      db.commentsForPost(env.DB, post.id),
      Promise.resolve({
        allow: s.get('allow_comments') === '1',
        audit: s.get('comment_audit') === '1',
        captcha: s.get('captcha') !== '0',   // 未设置即默认开启
      }),
    ]);
    return html(site.renderArticle(s, post, { siblings, comments, cfg }));
  }

  // 分类 /category /category/x[/page/n]
  if (seg[0] === 'category') {
    if (!seg[1]) {
      const cats = await db.listCategories(env.DB);
      const cards = cats.map((c) => `<div class="cat-card"><h3><a href="/category/${esc(c.slug)}">${esc(c.name)}</a></h3>
        ${c.description ? `<p>${esc(c.description)}</p>` : ''}<span class="cnt">${c.count || 0} 篇文章</span></div>`).join('');
      return html(site.renderListPage(s, { head: '全部分类', active: 'cat', title: '分类',
        itemsHtml: '', empty: '还没有分类', extra: `<div class="cat-grid">${cards}</div>` }));
    }
    const slug = seg[1];
    let page = 1;
    if (seg[2] === 'page' && seg[3]) page = pageNum(seg[3]);
    const cats = await db.listCategories(env.DB);
    const cat = cats.find((c) => c.slug === slug);
    if (!cat) return html(site.render404(s), 404);
    const data = await db.listPosts(env.DB, { status: 'published', cat: slug, page, per });
    const itemsHtml = data.items.map((p) => {
      const cover = p.cover_key ? `<div class="pc-cover"><a href="/post/${esc(p.slug)}"><img src="/media/${esc(p.cover_key)}" alt="" loading="lazy"></a></div>` : '';
      const tags = (p.tags || []).map((t) => `<a class="tag-chip" href="/tag/${esc(t.slug)}">${esc(t.name)}</a>`).join('');
      return `<article class="pc${cover ? '' : ' no-cover'}"><div>
        <div class="pc-meta"><time>${esc(p.published_at || '').slice(0, 10)}</time><span class="dot">·</span><span>阅读 ${p.view_count || 0}</span></div>
        <h2 class="pc-title"><a href="/post/${esc(p.slug)}">${esc(p.title)}</a></h2>
        ${p.excerpt ? `<p class="pc-excerpt">${esc(p.excerpt)}</p>` : ''}
        ${tags ? `<div class="pc-tags">${tags}</div>` : ''}</div>${cover}</article>`;
    }).join('');
    const makeUrl = (n) => (n <= 1 ? `/category/${slug}` : `/category/${slug}/page/${n}`);
    return html(site.renderListPage(s, {
      head: `分类：${cat.name}`, active: 'cat', title: cat.name, desc: cat.description || '',
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
      <h2 class="pc-title"><a href="/post/${esc(p.slug)}">${esc(p.title)}</a></h2></div></article>`).join('');
    const makeUrl = (n) => (n <= 1 ? `/tag/${slug}` : `/tag/${slug}/page/${n}`);
    return html(site.renderListPage(s, {
      head: `标签：${tag.name}`, active: 'tags', title: tag.name, desc: `共 ${data.total} 篇相关文章`,
      itemsHtml, empty: '该标签下暂无文章', page, pages: data.pages, makeUrl,
    }));
  }

  // 归档
  if (seg[0] === 'archive' && seg.length === 1) {
    const posts = await db.archivePosts(env.DB);
    return html(site.renderListPage(s, {
      head: '文章归档', active: 'arc', title: '归档',
      itemsHtml: '', empty: '还没有发布文章', extra: site.archiveContent(s, posts),
    }));
  }

  // 分类总览 /categories、标签总览 /tags（导航栏指向这两个地址，此前缺失导致 404）
  if ((seg[0] === 'categories' || seg[0] === 'tags') && seg.length === 1) {
    const isCat = seg[0] === 'categories';
    const list = isCat ? await db.listCategories(env.DB) : await db.listTags(env.DB);
    return html(isCat ? site.renderCategories(s, list) : site.renderTags(s, list));
  }

  // 搜索
  if (seg[0] === 'search' && seg.length === 1) {
    const q = (url.searchParams.get('q') || '').trim().slice(0, 60);
    let itemsHtml = '', total = 0;
    if (q) {
      const data = await db.listPosts(env.DB, { status: 'published', q, per: 20 });
      total = data.total;
      itemsHtml = data.items.map((p) => `<article class="pc no-cover"><div>
        <div class="pc-meta"><time>${esc(p.published_at || '').slice(0, 10)}</time><span class="dot">·</span><span>${p.view_count || 0} 阅读</span></div>
        <h2 class="pc-title"><a href="/post/${esc(p.slug)}">${esc(p.title)}</a></h2>
        ${p.excerpt ? `<p class="pc-excerpt">${esc(p.excerpt)}</p>` : ''}</div></article>`).join('');
    }
    return html(site.renderListPage(s, {
      head: q ? `“${esc(q)}” 的搜索结果` : '搜索', active: '', title: '搜索', q,
      desc: q ? `共找到 ${total} 篇文章` : '输入关键词搜索文章标题与摘要',
      itemsHtml, empty: q ? '没有找到相关文章' : '请输入搜索词', makeUrl: () => '',
    }));
  }

  // 404
  return html(site.render404(s), 404);
}

// ============ API ============
async function api(ctx, url, seg, method) {
  const { env, request } = ctx;
  const dbx = env.DB;
  const authUser = async () => userFromRequest(env, request);

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
    const salt = newSalt();
    const hash = await pbkdf2(password, salt);
    await db.setSetting(dbx, 'site_title', String(b.site_title || '').trim().slice(0, 60) || '我的博客');
    if (b.site_subtitle != null) await db.setSetting(dbx, 'site_subtitle', String(b.site_subtitle).slice(0, 80));
    if (b.author_name != null) await db.setSetting(dbx, 'author_name', String(b.author_name).slice(0, 30));
    if (b.accent && isHexColor(String(b.accent))) await db.setSetting(dbx, 'accent', b.accent);
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
    // 验证码一次性：用掉即作废（前端随后会自动换一张新图）
    return capOn ? jset({ ok: true, pending: audit }, clearCaptchaCookie()) : json({ ok: true, pending: audit });
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
      const key = `backups/backup-${bnNow().replace(/[-: ]/g, '')}.json`;
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
        return json({ ok: true, active: 'default' });
      }
      if (!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(id)) return err('主题 ID 不合法', 400);
      const css = await env.BLOG.get('themes/' + id + '/style.css');
      if (!css) return err('主题不存在或缺少 style.css', 404);
      await db.setSetting(dbx, 'active_theme', id);
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
        return json({ ok: true, deleted, activeFallback: 'default' });
      }
      return json({ ok: true, deleted });
    }
    return err('接口不存在', 404);
  }

  // --- 统计 ---
  if (seg[0] === 'stats' && method === 'GET' && seg.length === 1) return json(await db.stats(dbx));

  // --- 预览（返回完整 HTML 供编辑器 iframe 展示） ---
  if (seg[0] === 'preview' && method === 'POST' && seg.length === 1) {
    const b = (await readJson(request)) || {};
    const s = await db.settingsMap(dbx);
    const post = { title: String(b.title || '').trim().slice(0, 200), content_html: render(String(b.content_md || '')) };
    return json({ html: site.previewDoc(s, post, url.origin) });
  }

  // --- 设置 ---
  if (seg[0] === 'settings' && seg.length === 1) {
    if (method === 'GET') {
      const all = await db.allSettings(dbx);
      delete all.admin_pass_hash;
      delete all.admin_pass_salt;
      delete all.admin_pass_iter;
      return json(all);
    }
    if (method === 'PATCH') {
    const b = (await readJson(request)) || {};
    const allowed = { site_title: 60, site_subtitle: 80, author_name: 30, footer_text: 500, seo_desc: 200, beian: 100 };
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
    if (b.accent && isHexColor(String(b.accent))) await db.setSetting(dbx, 'accent', b.accent);
    if (b.new_password && String(b.new_password).length >= 6) {
      const salt = newSalt();
      await db.setSetting(dbx, 'admin_pass_salt', salt);
      await db.setSetting(dbx, 'admin_pass_hash', await pbkdf2(String(b.new_password), salt));
      await db.setSetting(dbx, 'admin_pass_iter', String(100000));
    }
    return json({ ok: true });
  }
  }

  // --- 分类管理 ---
  if (seg[0] === 'categories') {
    if (method === 'GET' && seg.length === 1) return json(await db.listCategories(dbx));
    if (method === 'POST' && seg.length === 1) {
      const b = (await readJson(request)) || {};
      const name = String(b.name || '').trim().slice(0, 30);
      if (!name) return err('请输入分类名称');
      const id = await db.createCategory(dbx, { name, slug: b.slug, description: String(b.description || '').slice(0, 200) });
      return json({ ok: true, id });
    }
    if (seg.length === 2 && /^\d+$/.test(seg[1])) {
      const id = parseInt(seg[1], 10);
      if (method === 'PUT') {
        const b = (await readJson(request)) || {};
        const name = String(b.name || '').trim().slice(0, 30);
        if (!name) return err('请输入分类名称');
        await db.updateCategory(dbx, id, { name, slug: b.slug, description: String(b.description || '').slice(0, 200) });
        return json({ ok: true });
      }
      if (method === 'DELETE') {
        await db.deleteCategory(dbx, id);
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
        return json({ ok: true });
      }
    }
    return err('接口不存在', 404);
  }

  // --- 文章管理 ---
  if (seg[0] === 'posts') {
    // 列表 GET /api/posts
    if (method === 'GET' && seg.length === 1) {
      const status = String(url.searchParams.get('status') || 'published');
      if (status !== 'published' && !user) return err('未登录', 401);
      return json(await db.listPosts(dbx, {
        status,
        q: url.searchParams.get('q') || '',
        cat: url.searchParams.get('cat') || undefined,
        tag: url.searchParams.get('tag') || undefined,
        page: parseInt(url.searchParams.get('page'), 10) || 1,
        per: Math.min(100, parseInt(url.searchParams.get('per'), 10) || 20),
      }));
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
        category_id: body.category_id ? parseInt(body.category_id, 10) : null,
        content_md: contentMd, content_html: contentHtml, excerpt,
        cover_key: body.cover_key || null, tags: Array.isArray(body.tags) ? body.tags : [],
      });
      const post = await db.getPost(dbx, { id });
      return json({ ok: true, id, slug: post.slug });
    }
    // 单篇操作 GET/PUT/DELETE /api/posts/:id
    if (seg.length === 2 && /^\d+$/.test(seg[1])) {
      const id = parseInt(seg[1], 10);
      const post = await db.getPost(dbx, { id });
      if (!post) return err('文章不存在', 404);
      if (method === 'GET') return json(post);
      if (method === 'DELETE') {
        await db.deletePost(dbx, id);
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
          category_id: body.category_id ? parseInt(body.category_id, 10) : null,
          content_md: contentMd, content_html: contentHtml, excerpt,
          cover_key: body.cover_key || null,
          tags: Array.isArray(body.tags) ? body.tags : [],
        });
        const np = await db.getPost(dbx, { id });
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
      return json({ ok: true });
    }
    if (method === 'DELETE') {
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
    return json({ ok: true });
  }

  return err('接口不存在', 404);
}

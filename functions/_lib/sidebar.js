// ============================================================
// 侧边栏（Ver 0.5 ②）
// 参考 WordPress「小工具」：一列可增删、可排序、可改标题的小挂件。
// 三个设置项全部存在 settings 表里（键/值），因此**备份与恢复自动带上**，
// 不需要新表、也不需要跑迁移：
//   sidebar_enabled  '1' | '0'      默认 '0'（＝现在的单栏博客）
//   sidebar_side     'right'|'left'
//   sidebar_items    JSON 数组
//
// 本文件只负责「按配置拼 HTML」；样式在 site.js 的 SIDEBAR_CSS，
// 后台编辑器在 public/admin/js/app.js。三处的**挂件类型必须一致**，
// 由 .sidebar-smoke.mjs 比对。
// ============================================================
import * as db from './db.js';
import { esc, postUrl, catUrl } from './util.js';
import { render as renderMd } from './md.js';

// ---------- 挂件目录 ----------
// count > 0 表示「这个挂件有显示条数」，后台给数字框；text 表示「有可编辑内容」。
// on 只用于「还没存过配置时」的默认勾选状态。
export const WIDGETS = [
  { type: 'about', name: '站点简介', title: '关于本站', on: true, count: 0, text: true },
  { type: 'search', name: '搜索', title: '搜索', on: true, count: 0, text: false },
  { type: 'hot', name: '热门文章', title: '热门文章', on: true, count: 5, text: false },
  { type: 'recent', name: '最新文章', title: '最新文章', on: true, count: 5, text: false },
  { type: 'comments', name: '最新评论', title: '最新评论', on: false, count: 5, text: false },
  { type: 'tags', name: '标签云', title: '标签云', on: true, count: 20, text: false },
  { type: 'cats', name: '分类列表', title: '分类', on: true, count: 10, text: false },
  { type: 'archive', name: '按月归档', title: '归档', on: false, count: 6, text: false },
  { type: 'links', name: '友情链接', title: '友情链接', on: false, count: 5, text: false },
  { type: 'stats', name: '站点统计', title: '站点统计', on: false, count: 0, text: false },
  { type: 'custom', name: '自定义内容', title: '自定义', on: false, count: 0, text: true },
];

export const WIDGET_TYPES = WIDGETS.map((w) => w.type);
const metaOf = (t) => WIDGETS.find((w) => w.type === t) || null;

// 没存过任何配置时的默认一套：按目录顺序，勾选项照目录的 on
export function defaultItems() {
  return WIDGETS
    .filter((w) => w.type !== 'custom')            // 自定义项要用户自己加
    .map((w) => ({ type: w.type, title: w.title, on: !!w.on, count: w.count || 0, text: '' }));
}

const str = (v, max) => {
  const s = typeof v === 'string' ? v : (v == null ? '' : String(v));
  return s.slice(0, max);
};
const intIn = (v, lo, hi, d) => {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return d;
  return Math.min(hi, Math.max(lo, n));
};

// ---------- 配置清洗 ----------
// 入参可以是 JSON 字符串（库里存的形态）或数组（后台提交 / 测试直传）。
// 态度：任何脏数据都「按目录修回可用形态」，绝不抛错 —— 配置坏了最多是侧边栏不出现，
// 不能让整站 500。
export function normalizeItems(raw) {
  let arr = [];
  if (Array.isArray(raw)) arr = raw;
  else if (typeof raw === 'string' && raw.trim()) {
    try { const p = JSON.parse(raw); if (Array.isArray(p)) arr = p; } catch (e) { arr = []; }
  }
  if (!arr.length) return defaultItems();
  const seen = new Set();
  const out = [];
  for (const one of arr.slice(0, 40)) {
    const it = (one && typeof one === 'object') ? one : {};
    const meta = metaOf(it.type);
    if (!meta) continue;
    // 内置挂件每种至多一个（重复没有意义，只会让后台列表看不懂）
    if (meta.type !== 'custom') {
      if (seen.has(meta.type)) continue;
      seen.add(meta.type);
    }
    const item = {
      type: meta.type,
      title: str(it.title || '', 40) || meta.title,
      on: it.on !== false,
      text: meta.text ? str(it.text, 4000) : '',
    };
    if (meta.count) item.count = intIn(it.count, 1, 30, meta.count);
    if (meta.type === 'custom') {
      item.id = /^[A-Za-z0-9_-]{1,24}$/.test(String(it.id || '')) ? String(it.id) : newId();
    }
    out.push(item);
  }
  return out.length ? out : defaultItems();
}

function newId() {
  return 'c' + Math.random().toString(36).slice(2, 8);
}
// 后台「添加自定义项目」时用它拿一个新 id（导出给测试用，服务端内部也用它兜底）
export const newWidgetId = newId;

// ---------- 渲染 ----------
const box = (title, inner, cls) =>
  `<section class="sd-w${cls ? ' ' + cls : ''}"><h2 class="sd-t">${esc(title)}</h2>${inner}</section>`;

// 列表型挂件的公共外壳：rank=true 时前面带序号方块
const listBox = (title, rows, rank) =>
  box(title, `<ul class="sd-list${rank ? ' rank' : ''}">${rows.join('')}</ul>`);

const liRank = (i, href, text, tail) =>
  `<li class="sd-i"><span class="sd-n">${i + 1}</span><a href="${esc(href)}">${esc(text)}</a>`
  + (tail ? `<span class="sd-c">${esc(tail)}</span>` : '') + '</li>';

const liPlain = (href, text, tail) =>
  `<li class="sd-i"><a href="${esc(href)}">${esc(text)}</a>`
  + (tail ? `<span class="sd-c">${esc(tail)}</span>` : '') + '</li>';

// 热门文章：按阅读量倒序
async function wHot(DB, s, it) {
  const r = await DB.prepare(
    `SELECT p.id,p.title,p.slug,p.published_at,c.slug AS cat_slug
       FROM posts p LEFT JOIN categories c ON c.id=p.category_id
      WHERE p.status='published' AND p.type='post'
      ORDER BY p.view_count DESC, p.id DESC LIMIT ?`
  ).bind(it.count).all();
  const rows = (r.results || []).map((p, i) => liRank(i, postUrl(s, p), p.title));
  if (!rows.length) return '';
  return listBox(it.title, rows, true);
}

// 最新文章：纯时间倒序（置顶不该插进「最新」）
async function wRecent(DB, s, it) {
  const r = await DB.prepare(
    `SELECT p.id,p.title,p.slug,p.published_at,c.slug AS cat_slug
       FROM posts p LEFT JOIN categories c ON c.id=p.category_id
      WHERE p.status='published' AND p.type='post'
      ORDER BY COALESCE(p.published_at,p.updated_at) DESC LIMIT ?`
  ).bind(it.count).all();
  const rows = (r.results || []).map((p) => liPlain(postUrl(s, p), p.title));
  if (!rows.length) return '';
  return listBox(it.title, rows, false);
}

// 最新评论：只取已通过；加密文章的评论一并跳过（否则会从标题泄题）
async function wComments(DB, s, it) {
  const r = await DB.prepare(
    `SELECT cm.id,cm.author,cm.content,cm.created_at,cm.is_admin,
            p.title AS post_title, p.slug AS post_slug, p.published_at, c.slug AS cat_slug
       FROM comments cm JOIN posts p ON p.id=cm.post_id
       LEFT JOIN categories c ON c.id=p.category_id
      WHERE cm.status='approved' AND p.status='published'
        AND (p.password IS NULL OR p.password='')
      ORDER BY cm.id DESC LIMIT ?`
  ).bind(it.count).all();
  const rows = (r.results || []).map((c) => {
    const who = esc(c.author || '匿名');
    const say = esc(String(c.content || '').replace(/\s+/g, ' ').slice(0, 60));
    const on = esc(c.post_title || '');
    // ⚠️ 必须拼出一个 postUrl 认得的对象：SQL 里别名为 post_slug / post_id，
    // 直接把原始行传给 postUrl 会取不到 slug，链接退化成 /post/（空地址）
    const href = postUrl(s, {
      slug: c.post_slug, id: c.post_id,
      published_at: c.published_at, cat_slug: c.cat_slug,
    });
    return `<li class="sd-cmt"><span class="sd-who">${who}${c.is_admin ? '<i class="sd-adm">博主</i>' : ''}</span>`
      + `<span class="sd-say">${say}</span>`
      + `<a class="sd-on" href="${esc(href)}">—— ${on}</a></li>`;
  });
  if (!rows.length) return '';
  return box(it.title, `<ul class="sd-cmts">${rows.join('')}</ul>`);
}

// 标签云：字号随文章数从 12.5px 到 18px 递增
async function wTags(DB, s, it) {
  const tags = await db.listTags(DB);
  const list = [...tags].filter((t) => (t.count || 0) > 0)
    .sort((a, b) => (b.count || 0) - (a.count || 0)).slice(0, it.count);
  if (!list.length) return '';
  const max = Math.max(...list.map((t) => t.count || 1));
  const min = Math.min(...list.map((t) => t.count || 0));
  const size = (n) => (max === min ? 14 : 12.5 + (n - min) / (max - min) * 5.5).toFixed(1);
  const pills = list.map((t) =>
    `<a class="sd-tag" href="/tag/${esc(t.slug)}" style="font-size:${size(t.count || 0)}px">${esc(t.name)}</a>`).join('');
  return box(it.title, `<div class="sd-cloud">${pills}</div>`);
}

// 分类列表：按树序（二级紧跟父分类）
async function wCats(DB, s, it) {
  const cats = await db.listCategories(DB);
  const tree = db.treeCategories(cats).slice(0, it.count);
  if (!tree.length) return '';
  const rows = tree.map((c) => liPlain(catUrl(c), (c.parent_id ? '└ ' : '') + c.name, c.count || 0));
  return listBox(it.title, rows, false);
}

// 按月归档：前台没有「某年某月」的独立页，所以统一跳归档页的按月视图
async function wArchive(DB, s, it) {
  const r = await DB.prepare(
    `SELECT substr(p.published_at,1,7) AS ym, COUNT(*) n FROM posts p
      WHERE p.status='published' AND p.type='post'
        AND p.published_at IS NOT NULL AND p.published_at<>''
      GROUP BY ym ORDER BY ym DESC LIMIT ?`
  ).bind(it.count).all();
  const rows = (r.results || []).map((x) => {
    const ym = String(x.ym || '');
    const label = `${ym.slice(0, 4)} 年 ${parseInt(ym.slice(5, 7), 10)} 月`;
    return liPlain('/archive?view=month', label, x.n);
  });
  if (!rows.length) return '';
  return listBox(it.title, rows, false);
}

async function wLinks(DB, s, it) {
  const links = await db.listLinks(DB, { status: 'approved' }).catch(() => []);
  const rows = links.slice(0, it.count).map((l) =>
    `<li class="sd-i"><a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.name)}</a></li>`);
  if (!rows.length) return '';
  return listBox(it.title, rows, false);
}

async function wStats(DB, s, it) {
  const st = await db.archiveStats(DB).catch(() => null);
  if (!st) return '';
  const cell = (n, t) => `<div class="sd-stat"><b>${Number(n) || 0}</b><span>${esc(t)}</span></div>`;
  const cells = [cell(st.posts, '篇文章'), cell(st.cats, '个分类'), cell(st.tags, '个标签'), cell(st.comments, '条评论')];
  return box(it.title, `<div class="sd-stats">${cells.join('')}</div>`);
}

function wSearch(s, it) {
  return box(it.title,
    `<form class="sd-search" action="/search" method="get">
      <input type="search" name="q" placeholder="搜索文章…" aria-label="搜索文章">
      <button type="submit">搜索</button>
    </form>`);
}

function wAbout(s, it) {
  const name = String(s.get('site_title') || '').trim();
  const sub = String(s.get('site_subtitle') || '').trim();
  const author = String(s.get('author_name') || '').trim();
  // ⚠️ 类名是 .sd-about，不是 .sd-me —— 后者是「最新评论」里的博主徽章（有底色），
  // 同名会让这个纯文字块被套上紫底，见 site.js SIDEBAR_CSS 的注释
  const head = (name || sub || author)
    ? `<div class="sd-about"><b>${esc(name)}</b>${sub ? `<span>${esc(sub)}</span>` : ''}`
      + `${author ? `<small>✍ ${esc(author)}</small>` : ''}</div>` : '';
  const body = it.text ? `<div class="sd-body">${renderMd(it.text)}</div>` : '';
  if (!head && !body) return '';
  return box(it.title, head + body, 'sd-w-about');
}

function wCustom(s, it) {
  if (!it.text) return '';
  return box(it.title, `<div class="sd-body">${renderMd(it.text)}</div>`, 'sd-w-custom');
}

// ---------- 入口 ----------
// 返回 '' 表示「这一页不出现侧边栏」（没开、一个都没勾、或全都没内容）。
export async function buildSidebar(env, s) {
  const DB = env && env.DB;
  if (!DB) return '';
  if (String(s.get('sidebar_enabled')) !== '1') return '';
  const items = normalizeItems(s.get('sidebar_items')).filter((x) => x.on);
  if (!items.length) return '';
  // 查询里用到 p.type / p.password，老库没跑迁移要先补列（内部有缓存，只做一次）
  await db.ensurePostCols(DB).catch(() => {});
  await db.ensureCatCols(DB).catch(() => {});

  const parts = [];
  for (const it of items) {
    try {
      let h = '';
      switch (it.type) {
        case 'about': h = wAbout(s, it); break;
        case 'search': h = wSearch(s, it); break;
        case 'hot': h = await wHot(DB, s, it); break;
        case 'recent': h = await wRecent(DB, s, it); break;
        case 'comments': h = await wComments(DB, s, it); break;
        case 'tags': h = await wTags(DB, s, it); break;
        case 'cats': h = await wCats(DB, s, it); break;
        case 'archive': h = await wArchive(DB, s, it); break;
        case 'links': h = await wLinks(DB, s, it); break;
        case 'stats': h = await wStats(DB, s, it); break;
        case 'custom': h = wCustom(s, it); break;
        default: h = '';
      }
      if (h) parts.push(h);
    } catch (e) {
      // 单个挂件挂了只丢这一个，绝不连累整页（前台照常出正文）
      console.error('sidebar widget error:', it.type, (e && e.message) || e);
    }
  }
  return parts.length ? parts.join('\n') : '';
}

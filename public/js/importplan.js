// ============================================================
// 导入规划：把三家程序的数据翻译成本站的表与列（Ver 0.7 ①）
//
// 主键策略是「全量重编号」：从本站各表的 MAX(id)+1 起重新发号，
// 再维护一张「源 id → 新 id」的映射表，把 category_id / post_id /
// parent_id / post_tags 全部按映射改写。
//
// 为什么不用「整体加 100000」：那只是把撞车概率压低，本站 id 一旦长到
// 十万以上就又会撞；而重编号的号段全部取自本站空号区，数学上不可能冲突。
// 代价是源站 id 与本站 id 对不上——但永久链接默认是 /post/{slug}，
// 读者看不到 id，所以这个代价不存在。
//
// 纯函数，不碰数据库：入参是解析结果 + 本站现状，出参是待写入的行。
// ============================================================

import { htmlToMarkdown, htmlToText, cleanMarkdown, decodeEntities } from './html2md.js';

const PAGE_TYPES = new Set(['page', 'page_draft']);

function findT(dump, suffix) {
  for (const [name, t] of dump.tables) {
    if (name === suffix || name.endsWith('_' + suffix)) {
      return { name, t };
    }
  }
  return null;
}

// 把「列名 → 值」的行转成小写键的对象：三家的大小写习惯完全不同
// （WP 的 ID、Typecho 的 cid、Z-Blog 的 log_ID），统一之后再取就简单了。
function objects(entry) {
  if (!entry || !entry.t.cols) return [];
  const cols = entry.t.cols.map((c) => String(c).toLowerCase());
  return entry.t.rows.map((r) => {
    const o = {};
    for (let i = 0; i < cols.length; i++) o[cols[i]] = r[i];
    return o;
  });
}

function g(o, ...names) {
  for (const n of names) {
    const k = String(n).toLowerCase();
    if (o[k] !== undefined && o[k] !== null) return o[k];
  }
  return '';
}

function num(v, fb = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// 源站时间可能是 'YYYY-MM-DD HH:MM:SS'、ISO、只有日期，或 Unix 时间戳。
// 一律归一成本站的 `YYYY-MM-DD HH:MM:SS`（北京时间），认不出就用兜底值。
export function normTime(v, fb = '') {
  if (v === null || v === undefined || v === '') return fb;
  const s = String(v).trim();
  if (/^\d{10}$/.test(s)) return fromEpoch(Number(s));
  if (/^\d{13}$/.test(s)) return fromEpoch(Math.floor(Number(s) / 1000));
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/.exec(s);
  if (!m) return fb;
  const yy = m[1];
  const mo = m[2];
  const dd = m[3];
  if (yy === '0000' || mo === '00' || dd === '00') return fb;
  return `${yy}-${pad2(mo)}-${pad2(dd)} ${pad2(m[4] || 0)}:${pad2(m[5] || 0)}:${pad2(m[6] || 0)}`;
}

function fromEpoch(sec) {
  const d = new Date((sec + 8 * 3600) * 1000);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

// 本站 slug 只保留 ascii 小写字母数字（中文标题会变空），空了就用编号兜底。
export function slugBase(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  try {
    s = decodeURIComponent(s);
  } catch (e) {
    /* 不是百分号编码就原样用 */
  }
  s = s.replace(/^\/+|\/+$/g, '').split('/').pop() || '';
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function uniqueSlug(base, taken, fallback) {
  let s = base || fallback;
  if (!taken.has(s)) {
    taken.add(s);
    return s;
  }
  for (let i = 2; i < 100000; i++) {
    const c = s + '-' + i;
    if (!taken.has(c)) {
      taken.add(c);
      return c;
    }
  }
  const c = s + '-' + Date.now().toString(36);
  taken.add(c);
  return c;
}

function hasTag(html) {
  return /<[a-z][\w:-]*(\s[^>]*)?>/i.test(String(html || ''));
}

function bodyOf(raw, asMarkdown, base) {
  if (asMarkdown) {
    return { md: cleanMarkdown(raw), html: '' };
  }
  const html = String(raw == null ? '' : raw);
  if (!hasTag(html)) return { md: cleanMarkdown(html), html: '' };
  return { md: htmlToMarkdown(html, { base }), html };
}

function excerptOf(rawExcerpt, body, max = 150) {
  const ex = String(rawExcerpt || '').trim();
  if (ex) return hasTag(ex) ? htmlToText(ex, max) : ex.slice(0, max);
  const txt = hasTag(body.html) ? htmlToText(body.html, max) : String(body.md || '').replace(/[#>*`[\]()]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
  return txt;
}

function siteBaseOf(dump, program) {
  // 从配置表里捞源站地址：正文里相对路径的图片拼成绝对地址，
  // 否则导进来全是 404。文章内部的相对链接不拼（那是站内跳转，拼了反而变外链）。
  try {
    if (program === 'wordpress') {
      const opt = findT(dump, 'options');
      for (const o of objects(opt)) {
        const k = String(g(o, 'option_name')).toLowerCase();
        if (k === 'siteurl' || k === 'home') {
          const v = String(g(o, 'option_value')).trim();
          if (/^https?:\/\//i.test(v)) return v.replace(/\/+$/, '') + '/';
        }
      }
    }
    if (program === 'typecho') {
      const opt = findT(dump, 'options');
      for (const o of objects(opt)) {
        const k = String(g(o, 'name')).toLowerCase();
        if (k === 'siteurl') {
          const v = String(g(o, 'value')).trim();
          if (/^https?:\/\//i.test(v)) return v.replace(/\/+$/, '') + '/';
        }
      }
    }
    if (program === 'zblog') {
      const cfg = findT(dump, 'config');
      for (const o of objects(cfg)) {
        const k = String(g(o, 'conf_name')).toLowerCase();
        if (k === 'zc_blog_host') {
          const v = String(g(o, 'conf_value')).trim();
          if (/^https?:\/\//i.test(v)) return v.replace(/\/+$/, '') + '/';
        }
      }
    }
  } catch (e) {
    /* 配置表长什么样都可能，认不出就算了 */
  }
  return '';
}

function imgCount(html) {
  return (String(html || '').match(/<img\b/gi) || []).length;
}

// ------------------------------------------------------------
// 主入口
// meta: { maxIds:{posts,categories,tags,comments}, slugs:{posts:[],categories:[],tags:[]} }
// ------------------------------------------------------------
export function planImport(dump, meta = {}, opts = {}) {
  const program = dump.program && dump.program.key;
  const now = opts.now || '';
  const maxIds = meta.maxIds || {};
  const slugSets = {
    posts: new Set((meta.slugs && meta.slugs.posts) || []),
    categories: new Set((meta.slugs && meta.slugs.categories) || []),
    tags: new Set((meta.slugs && meta.slugs.tags) || []),
  };
  const seq = {
    posts: num(maxIds.posts) + 1,
    categories: num(maxIds.categories) + 1,
    tags: num(maxIds.tags) + 1,
    comments: num(maxIds.comments) + 1,
  };

  const out = { categories: [], tags: [], posts: [], post_tags: [], comments: [] };
  const report = {
    program,
    programName: (dump.program && dump.program.name) || '',
    dialect: dump.dialect,
    counts: { posts: 0, pages: 0, categories: 0, tags: 0, comments: 0, postTags: 0 },
    skipped: { posts: 0, comments: 0, categories: 0, tags: 0 },
    reasons: {},
    renamed: [],
    warnings: [],
    encrypted: 0,
    images: 0,
    admins: 0,
    sourceBase: '',
  };
  const skip = (kind, why) => {
    report.skipped[kind] = (report.skipped[kind] || 0) + 1;
    report.reasons[why] = (report.reasons[why] || 0) + 1;
  };

  const base = siteBaseOf(dump, program);
  report.sourceBase = base;

  const catMap = new Map(); // 源分类 id -> 新 id
  const tagMap = new Map(); // 源标签 id -> 新 id

  // ---------- 分类 / 标签 ----------
  const addCategory = (srcId, name, slug, desc, parentSrc, inNav) => {
    const nm = String(name || '').trim();
    if (!nm) {
      skip('categories', '分类名为空');
      return null;
    }
    if (catMap.has(srcId)) return catMap.get(srcId);
    const id = seq.categories++;
    const s = uniqueSlug(slugBase(slug), slugSets.categories, 'cat-' + id);
    if (s !== slugBase(slug) && slugBase(slug)) report.renamed.push({ kind: '分类', from: slugBase(slug), to: s });
    out.categories.push({
      id,
      name: nm.slice(0, 60),
      slug: s,
      description: String(desc || '').slice(0, 500),
      created_at: now,
      parent_id: 0,
      in_nav: inNav ? 1 : 0,
      // 父分类可能还没轮到，先记源 id，等全部建完再回填
      _parentSrc: parentSrc === null || parentSrc === undefined ? '' : String(parentSrc),
    });
    catMap.set(srcId, id);
    report.counts.categories++;
    return id;
  };

  const addTag = (srcId, name, slug) => {
    const nm = String(name || '').trim();
    if (!nm) {
      skip('tags', '标签名为空');
      return null;
    }
    if (tagMap.has(srcId)) return tagMap.get(srcId);
    const id = seq.tags++;
    const s = uniqueSlug(slugBase(slug), slugSets.tags, 'tag-' + id);
    if (s !== slugBase(slug) && slugBase(slug)) report.renamed.push({ kind: '标签', from: slugBase(slug), to: s });
    out.tags.push({ id, name: nm.slice(0, 60), slug: s, created_at: now });
    tagMap.set(srcId, id);
    report.counts.tags++;
    return id;
  };

  // ---------- 文章 ----------
  const postMap = new Map(); // 源文章 id -> 新 id
  const addPost = (srcId, f) => {
    if (!f.title && !f.body.md && !f.body.html) {
      skip('posts', '标题与正文都是空的');
      return null;
    }
    if (f.status === 'skip') {
      skip('posts', f.why || '源站状态为回收站 / 自动草稿');
      return null;
    }
    const id = seq.posts++;
    const fb = (f.type === 'page' ? 'page-' : 'post-') + id;
    const s = uniqueSlug(slugBase(f.slug), slugSets.posts, fb);
    if (s !== slugBase(f.slug) && slugBase(f.slug)) report.renamed.push({ kind: f.type === 'page' ? '页面' : '文章', from: slugBase(f.slug), to: s });
    const title = String(f.title || '').trim() || '无标题';
    const published = f.status === 'published' ? (f.published_at || now) : null;
    const row = {
      id,
      title: title.slice(0, 300),
      slug: s,
      excerpt: excerptOf(f.excerpt, f.body).slice(0, 500),
      content_md: f.body.md,
      content_html: f.body.html,
      cover_key: null,
      status: f.status === 'published' ? 'published' : 'draft',
      category_id: f.categoryId || null,
      view_count: Math.max(0, num(f.views)),
      created_at: f.created_at || now,
      updated_at: f.updated_at || f.created_at || now,
      published_at: published,
      type: f.type === 'page' ? 'page' : 'post',
      in_nav: f.inNav ? 1 : 0,
      password: '',
      pin: 0,
    };
    // WordPress 的特色图不一定出现在正文里，先记下它的相对路径，
    // 等附件包到了再由 attach.js 配对成 cover_key。
    if (f.coverRef) row._cover_ref = f.coverRef;
    out.posts.push(row);
    postMap.set(srcId, id);
    if (f.body.html) report.images += imgCount(f.body.html);
    if (f.hasPassword) report.encrypted++;
    report.counts[f.type === 'page' ? 'pages' : 'posts']++;
    return id;
  };

  // ---------- 评论 ----------
  const addComment = (srcId, f) => {
    const pid = postMap.get(f.postSrc);
    if (!pid) {
      skip('comments', '所属文章没有被导入');
      return null;
    }
    const id = seq.comments++;
    if (f.isAdmin) report.admins++;
    out.comments.push({
      id,
      post_id: pid,
      parent_id: null, // 第二轮再补，父评论可能还没分配
      author: String(f.author || '匿名').trim().slice(0, 40) || '匿名',
      email: String(f.email || '').slice(0, 120),
      website: String(f.website || '').slice(0, 300),
      content: f.content,
      status: f.status,
      is_admin: f.isAdmin ? 1 : 0,
      ip: String(f.ip || '').slice(0, 60),
      created_at: f.created_at || now,
      _parentSrc: f.parentSrc,
      _srcId: srcId,
    });
    report.counts.comments++;
    return id;
  };

  const linkTags = (postSrcId, tagSrcIds, postId) => {
    const seen = new Set();
    for (const tid of tagSrcIds) {
      const newTag = tagMap.get(tid);
      if (!newTag || seen.has(newTag)) continue;
      seen.add(newTag);
      out.post_tags.push({ post_id: postId, tag_id: newTag });
      report.counts.postTags++;
    }
  };

  const api = { addCategory, addTag, addPost, addComment, linkTags, postMap, catMap, tagMap, report, skip, base };
  if (program === 'wordpress') planWordPress(dump, api);
  else if (program === 'typecho') planTypecho(dump, api);
  else if (program === 'zblog') planZBlog(dump, api);

  // ---------- 分类树的父级（第二轮，父分类此时一定已分配） ----------
  for (const c of out.categories) {
    if (c._parentSrc !== undefined) {
      const p = catMap.get(c._parentSrc);
      c.parent_id = p && p !== c.id ? p : 0;
      delete c._parentSrc;
    }
  }

  // ---------- 评论的父子关系（第二轮） ----------
  const cmtSrcToNew = new Map();
  for (const c of out.comments) cmtSrcToNew.set(String(c._srcId), c.id);
  for (const c of out.comments) {
    const ps = c._parentSrc;
    if (ps !== undefined && ps !== null && ps !== '' && num(ps) > 0) {
      const p = cmtSrcToNew.get(String(ps));
      // 父评论被跳过（垃圾评论 / 所属文章没进来）时挂到根上，而不是挂一个不存在的 id
      c.parent_id = p && p !== c.id ? p : null;
    }
    delete c._parentSrc;
    delete c._srcId;
  }

  if (report.encrypted) report.warnings.push(`有 ${report.encrypted} 篇文章带访问密码，密码无法从源站哈希还原，已按普通文章导入`);
  // 图片那句提示不在这里出：能不能搬文件取决于用户有没有补附件包，
  // 由导入界面按实际配上的数量来说（见 attach.js）。
  if (report.renamed.length) report.warnings.push(`${report.renamed.length} 条链接别名与本站已有内容重名，已自动加 -2 / -3 后缀`);
  if (report.skipped.posts) report.warnings.push(`${report.skipped.posts} 篇内容被跳过（回收站 / 自动草稿 / 空内容），明细见下方`);
  if (report.skipped.comments) report.warnings.push(`${report.skipped.comments} 条评论被跳过（垃圾评论 / 所属文章未导入）`);

  return { plan: out, report };
}

// ------------------------------------------------------------
// WordPress
// ------------------------------------------------------------
function planWordPress(dump, ctx) {
  const { addCategory, addTag, addPost, addComment, linkTags, postMap, catMap, tagMap, report, base } = ctx;

  const terms = objects(findT(dump, 'terms'));
  const taxes = objects(findT(dump, 'term_taxonomy'));
  const rels = objects(findT(dump, 'term_relationships'));

  const termById = new Map();
  for (const t of terms) termById.set(String(g(t, 'term_id')), t);

  const taxById = new Map();   // term_taxonomy_id -> {term_id, taxonomy, parent, description}
  for (const x of taxes) {
    taxById.set(String(g(x, 'term_taxonomy_id')), {
      termId: String(g(x, 'term_id')),
      taxonomy: String(g(x, 'taxonomy')),
      parent: g(x, 'parent'),
      description: String(g(x, 'description') || ''),
    });
  }

  // 分类与标签都先建好（即使没有文章引用）
  for (const x of taxes) {
    const tx = taxById.get(String(g(x, 'term_taxonomy_id')));
    const term = termById.get(tx.termId);
    if (!term) continue;
    if (tx.taxonomy === 'category') {
      addCategory(tx.termId, g(term, 'name'), g(term, 'slug'), tx.description, tx.parent, 0);
    } else if (tx.taxonomy === 'post_tag') {
      addTag(tx.termId, g(term, 'name'), g(term, 'slug'));
    }
  }

  // 每篇文章对应的分类 / 标签
  const relByPost = new Map();
  for (const r of rels) {
    const oid = String(g(r, 'object_id'));
    const tx = taxById.get(String(g(r, 'term_taxonomy_id')));
    if (!tx) continue;
    if (!relByPost.has(oid)) relByPost.set(oid, { cats: [], tags: [] });
    const bucket = relByPost.get(oid);
    if (tx.taxonomy === 'category') bucket.cats.push(tx.termId);
    else if (tx.taxonomy === 'post_tag') bucket.tags.push(tx.termId);
  }

  // 附件台账（只用于配对，不写库）：
  //   _wp_attached_file 给的是「相对 uploads 的路径」，比 guid 可靠 ——
  //   guid 里常留着站点搬家前的旧域名，照它去配包必然配不上。
  //   _thumbnail_id 指向附件行，等于这篇的特色图。
  const meta = objects(findT(dump, 'postmeta'));
  const attFile = new Map();   // attachment post_id -> 相对路径
  const thumbOf = new Map();   // post_id -> attachment post_id
  for (const m of meta) {
    const key = String(g(m, 'meta_key') || '');
    const pid = String(g(m, 'post_id'));
    const val = String(g(m, 'meta_value') || '');
    if (!pid || !val) continue;
    if (key === '_wp_attached_file') attFile.set(pid, val);
    else if (key === '_thumbnail_id') thumbOf.set(pid, val);
  }

  for (const p of objects(findT(dump, 'posts'))) {
    const srcId = String(g(p, 'id'));
    const ptype = String(g(p, 'post_type') || 'post');
    if (ptype !== 'post' && ptype !== 'page') {
      report.skipped.posts = (report.skipped.posts || 0) + 1;
      report.reasons[ptype === 'attachment' ? '附件（图片 / 文件）不导入' : `内容类型 ${ptype} 不导入`] =
        (report.reasons[ptype === 'attachment' ? '附件（图片 / 文件）不导入' : `内容类型 ${ptype} 不导入`] || 0) + 1;
      continue;
    }
    const st = String(g(p, 'post_status') || '');
    const statusMap = { publish: 'published', private: 'draft', draft: 'draft', pending: 'draft', future: 'draft' };
    const status = statusMap[st] || 'skip';
    if (status === 'skip') {
      report.skipped.posts = (report.skipped.posts || 0) + 1;
      const why = st === 'trash' ? '回收站' : st === 'auto-draft' ? '自动草稿' : st === 'inherit' ? '修订版本' : `状态 ${st || '未知'}`;
      report.reasons[why] = (report.reasons[why] || 0) + 1;
      continue;
    }
    const body = bodyOf(g(p, 'post_content'), false, base);
    const rel = relByPost.get(srcId) || { cats: [], tags: [] };
    const newId = addPost(srcId, {
      title: g(p, 'post_title'),
      slug: g(p, 'post_name'),
      excerpt: g(p, 'post_excerpt'),
      body,
      status,
      categoryId: catMap.get(rel.cats[0]) || null,
      views: 0,
      created_at: normTime(g(p, 'post_date'), ''),
      updated_at: normTime(g(p, 'post_modified'), ''),
      published_at: normTime(g(p, 'post_date'), ''),
      type: ptype === 'page' ? 'page' : 'post',
      inNav: false,
      hasPassword: !!String(g(p, 'post_password') || ''),
      coverRef: attFile.get(thumbOf.get(srcId)) || '',
    });
    if (newId) linkTags(srcId, rel.tags, newId);
  }

  // 评论
  for (const c of objects(findT(dump, 'comments'))) {
    const ap = String(g(c, 'comment_approved'));
    let status = 'approved';
    if (ap === '0' || ap === 'hold') status = 'pending';
    else if (ap === 'spam' || ap === 'trash') {
      report.skipped.comments = (report.skipped.comments || 0) + 1;
      report.reasons[ap === 'spam' ? '垃圾评论' : '回收站里的评论'] = (report.reasons[ap === 'spam' ? '垃圾评论' : '回收站里的评论'] || 0) + 1;
      continue;
    }
    addComment(String(g(c, 'comment_id')), {
      postSrc: String(g(c, 'comment_post_id')),
      parentSrc: g(c, 'comment_parent'),
      author: g(c, 'comment_author'),
      email: g(c, 'comment_author_email'),
      website: g(c, 'comment_author_url'),
      content: plainComment(g(c, 'comment_content')),
      status,
      isAdmin: num(g(c, 'user_id')) > 0,
      ip: g(c, 'comment_author_ip'),
      created_at: normTime(g(c, 'comment_date'), ''),
    });
  }
}

// ------------------------------------------------------------
// Typecho
// ------------------------------------------------------------
function planTypecho(dump, ctx) {
  const { addCategory, addTag, addPost, addComment, linkTags, postMap, catMap, tagMap, report, base } = ctx;

  // users 表用来判断「博主自己回复的评论」：Typecho 只有登录用户才有 authorId
  const adminIds = new Set();
  for (const u of objects(findT(dump, 'users'))) {
    const grp = String(g(u, 'group')).toLowerCase();
    if (grp === 'administrator' || grp === 'admin' || grp === 'editor') adminIds.add(String(g(u, 'uid')));
  }

  const metas = objects(findT(dump, 'metas'));
  const metaById = new Map();
  for (const m of metas) metaById.set(String(g(m, 'mid')), m);

  for (const m of metas) {
    const type = String(g(m, 'type')).toLowerCase();
    if (type === 'category') addCategory(String(g(m, 'mid')), g(m, 'name'), g(m, 'slug'), g(m, 'description'), g(m, 'parent'), 0);
    else if (type === 'tag') addTag(String(g(m, 'mid')), g(m, 'name'), g(m, 'slug'));
  }

  // 关系表：源文章 id -> {cats, tags}
  const relByPost = new Map();
  for (const r of objects(findT(dump, 'relationships'))) {
    const cid = String(g(r, 'cid'));
    const mid = String(g(r, 'mid'));
    const m = metaById.get(mid);
    if (!m) continue;
    if (!relByPost.has(cid)) relByPost.set(cid, { cats: [], tags: [] });
    const type = String(g(m, 'type')).toLowerCase();
    if (type === 'category') relByPost.get(cid).cats.push(mid);
    else if (type === 'tag') relByPost.get(cid).tags.push(mid);
  }

  for (const p of objects(findT(dump, 'contents'))) {
    const srcId = String(g(p, 'cid'));
    const type = String(g(p, 'type') || 'post');
    if (!['post', 'page', 'post_draft', 'page_draft'].includes(type)) {
      report.skipped.posts = (report.skipped.posts || 0) + 1;
      report.reasons[`内容类型 ${type} 不导入`] = (report.reasons[`内容类型 ${type} 不导入`] || 0) + 1;
      continue;
    }
    const raw = String(g(p, 'text') || '');
    // Typecho 的 Markdown 正文带 <!--markdown--> 前缀；没有前缀当 HTML 处理
    const isMd = /^\s*<!--\s*markdown\s*-->/i.test(raw);
    const st = String(g(p, 'status') || 'publish').toLowerCase();
    // 类型本身带 draft 的（post_draft / page_draft），状态字段即使是 publish 也算草稿
    const status = st === 'publish' && !type.endsWith('_draft') ? 'published' : 'draft';
    const rel = relByPost.get(srcId) || { cats: [], tags: [] };
    const body = bodyOf(raw, isMd, base);
    const newId = addPost(srcId, {
      title: g(p, 'title'),
      slug: g(p, 'slug'),
      excerpt: '',
      body,
      status,
      categoryId: catMap.get(rel.cats[0]) || null,
      views: 0,
      created_at: normTime(g(p, 'created'), ''),
      updated_at: normTime(g(p, 'modified'), ''),
      published_at: normTime(g(p, 'created'), ''),
      type: type.startsWith('page') ? 'page' : 'post',
      inNav: false,
      hasPassword: !!String(g(p, 'password') || ''),
    });
    if (newId) linkTags(srcId, rel.tags, newId);
  }

  for (const c of objects(findT(dump, 'comments'))) {
    const st = String(g(c, 'status') || 'approved').toLowerCase();
    let status = 'approved';
    if (st === 'waiting' || st === 'pending') status = 'pending';
    else if (st === 'spam') {
      report.skipped.comments = (report.skipped.comments || 0) + 1;
      report.reasons['垃圾评论'] = (report.reasons['垃圾评论'] || 0) + 1;
      continue;
    }
    const uid = String(g(c, 'authorid'));
    addComment(String(g(c, 'coid')), {
      postSrc: String(g(c, 'cid')),
      parentSrc: g(c, 'parent'),
      author: g(c, 'author'),
      email: g(c, 'mail'),
      website: g(c, 'url'),
      content: plainComment(g(c, 'text')),
      status,
      isAdmin: num(uid) > 0 && (adminIds.size ? adminIds.has(uid) : true),
      ip: g(c, 'ip'),
      created_at: normTime(g(c, 'created'), ''),
    });
  }
}

// ------------------------------------------------------------
// Z-BlogPHP
// ------------------------------------------------------------
function planZBlog(dump, ctx) {
  const { addCategory, addTag, addPost, addComment, linkTags, postMap, catMap, tagMap, report, base } = ctx;

  for (const c of objects(findT(dump, 'category'))) {
    addCategory(String(g(c, 'cate_id')), g(c, 'cate_name'), g(c, 'cate_alias'), g(c, 'cate_intro'), g(c, 'cate_parentid'), 0);
  }

  for (const t of objects(findT(dump, 'tag'))) {
    addTag(String(g(t, 'tag_id')), g(t, 'tag_name'), g(t, 'tag_alias'));
  }

  for (const p of objects(findT(dump, 'post'))) {
    const srcId = String(g(p, 'log_id'));
    const ltype = String(g(p, 'log_type') || '0');
    const status0 = String(g(p, 'log_status') || '0');
    // 0 公开 / 1 草稿 / 2 审核中；更特殊的状态（如密码保护）按草稿处理
    const status = status0 === '0' ? 'published' : 'draft';
    const body = bodyOf(g(p, 'log_content'), false, base);
    const tagStr = String(g(p, 'log_tag') || '');
    const tagIds = (tagStr.match(/\{(\d+)\}/g) || []).map((x) => x.replace(/[{}]/g, ''));
    const catId = catMap.get(String(g(p, 'log_cateid')));
    const newId = addPost(srcId, {
      title: g(p, 'log_title'),
      slug: g(p, 'log_alias'),
      excerpt: g(p, 'log_intro'),
      body,
      status,
      categoryId: catId || null,
      views: num(g(p, 'log_viewnums')),
      created_at: normTime(g(p, 'log_createtime'), ''),
      updated_at: normTime(g(p, 'log_updatetime'), ''),
      published_at: normTime(g(p, 'log_posttime'), ''),
      type: ltype === '1' ? 'page' : 'post',
      inNav: false,
      hasPassword: false,
    });
    if (newId) linkTags(srcId, tagIds, newId);
  }

  for (const c of objects(findT(dump, 'comment'))) {
    const checking = String(g(c, 'comm_ischecking') || '0');
    addComment(String(g(c, 'comm_id')), {
      postSrc: String(g(c, 'comm_logid')),
      parentSrc: g(c, 'comm_parentid'),
      author: g(c, 'comm_author'),
      email: g(c, 'comm_email'),
      website: g(c, 'comm_homepage'),
      content: plainComment(g(c, 'comm_content')),
      status: checking === '1' ? 'pending' : 'approved',
      isAdmin: num(g(c, 'comm_authorid')) > 0,
      ip: g(c, 'comm_ip'),
      created_at: normTime(g(c, 'comm_posttime'), ''),
    });
  }
}

// 评论内容在本站是**纯文本**（渲染时按 \n 切、逐段 esc），
// 所以源站的 HTML 评论要先降级成文本，否则会原样显示成一堆标签。
function plainComment(raw) {
  const s = String(raw == null ? '' : raw);
  if (!hasTag(s)) return s.replace(/\r\n/g, '\n').trim();
  const t = s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|blockquote|h[1-6])>/gi, '\n\n')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(t)
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

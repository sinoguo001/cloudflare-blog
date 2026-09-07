// ============================================================
// 博客后台单页应用入口：鉴权 -> 布局 -> Hash 路由 -> 各管理视图
// ============================================================
import { API } from './api.js';
import { esc, el, toast, dialog, confirmDanger, fmtSize, fmtTime } from './ui.js';
import { Editor } from './editor.js';

const app = document.getElementById('app');
let state = { installed: true, authed: false, username: '' };
let listTab = 'all';
let commentTab = 'pending';
let editor = null; // 当前编辑器实例
let dirty = false; // 文章是否有未保存修改（全局守卫用）
let draftSaver = null; // 由编辑器页注入的“保存草稿”函数（Ctrl+S 用）

// ---------- 工具 ----------
function pageTitle(t) { document.title = (t ? t + ' · ' : '') + '博客管理后台'; }
async function statsBadge() {
  try {
    const st = await API.get('/stats');
    const elBadge = document.getElementById('badge-pending');
    if (elBadge) {
      elBadge.textContent = st.pending || '';
      elBadge.style.display = st.pending > 0 ? '' : 'none';
    }
  } catch (e) { /* 静默 */ }
}
function showLoading(msg) {
  app.innerHTML = `<div class="loading">${esc(msg || '加载中…')}</div>`;
}
const go = (hash) => { location.hash = hash; };

// ---------- 认证视图 ----------
function viewLogin() {
  pageTitle('登录');
  app.innerHTML = `
  <div class="auth-wrap"><div class="auth-card">
    <h1><span class="brand-mark">博</span>博客管理后台</h1>
    <p class="sub">请输入管理员账号登录</p>
    <form id="lg">
      <div class="field"><label>用户名</label><input class="inp" name="username" autocomplete="username" required></div>
      <div class="field"><label>密码</label><input class="inp" type="password" name="password" autocomplete="current-password" required></div>
      <button class="btn p" style="width:100%;justify-content:center" type="submit">登 录</button>
      <p class="form-err" id="lg-err"></p>
    </form>
  </div></div>`;
  app.querySelector('#lg').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const errEl = app.querySelector('#lg-err');
    errEl.textContent = '';
    try {
      const fd = new FormData(ev.target);
      await API.post('/auth/login', { username: fd.get('username'), password: fd.get('password') });
      toast('登录成功');
      location.hash = '#/posts';
      await boot();
    } catch (e) { errEl.textContent = e.message; }
  });
}

function viewSetup() {
  pageTitle('初始化');
  app.innerHTML = `
  <div class="auth-wrap"><div class="auth-card">
    <h1>欢迎使用博客系统</h1>
    <p class="sub">首次部署：填写站点信息并创建管理员账号（仅本次可用）</p>
    <form id="st">
      <div class="field"><label>站点名称</label><input class="inp" name="site_title" value="我的博客" maxlength="60" required></div>
      <div class="field"><label>副标题（首页大字标语）</label><input class="inp" name="site_subtitle" value="记录 · 思考 · 分享" maxlength="80"></div>
      <div class="field"><label>作者署名</label><input class="inp" name="author_name" value="博主" maxlength="30"></div>
      <div style="display:flex;gap:14px">
        <div class="field" style="flex:1"><label>管理员用户名</label><input class="inp" name="username" placeholder="3–32 位字母数字下划线" required></div>
        <div class="field" style="flex:1"><label>主题色</label><input class="inp" name="accent" type="color" value="#2563eb" style="height:40px;padding:4px"></div>
      </div>
      <div style="display:flex;gap:14px">
        <div class="field" style="flex:1"><label>密码</label><input class="inp" type="password" name="password" minlength="6" required></div>
        <div class="field" style="flex:1"><label>确认密码</label><input class="inp" type="password" name="password2" minlength="6" required></div>
      </div>
      <button class="btn p" style="width:100%;justify-content:center" type="submit">创建并进入后台</button>
      <p class="form-err" id="st-err"></p>
    </form>
  </div></div>`;
  app.querySelector('#st').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const errEl = app.querySelector('#st-err');
    errEl.textContent = '';
    const fd = new FormData(ev.target);
    if (fd.get('password') !== fd.get('password2')) { errEl.textContent = '两次输入的密码不一致'; return; }
    try {
      await API.post('/setup', Object.fromEntries(fd.entries()));
      toast('初始化完成，欢迎使用');
      location.hash = '#/posts';
      await boot();
    } catch (e) { errEl.textContent = e.message; }
  });
}

// ---------- 主布局 ----------
function shell(contentHtml) {
  app.innerHTML = `
  <header class="topbar"><div class="tb-in">
    <a class="tb-brand" href="#/posts"><span class="brand-mark">博</span>博客后台</a>
    <nav class="tb-nav" id="tb-nav">
      <a href="#/posts" data-nav="posts">文章</a>
      <a href="#/comments" data-nav="comments">评论<span class="badge" id="badge-pending" style="display:none"></span></a>
      <a href="#/categories" data-nav="categories">分类与标签</a>
      <a href="#/media" data-nav="media">图片库</a>
      <a href="#/themes" data-nav="themes">主题</a>
      <a href="#/backup" data-nav="backup">备份与恢复</a>
      <a href="#/settings" data-nav="settings">设置</a>
      <span class="sep">|</span>
      <a href="/" target="_blank" rel="noopener">查看站点 ↗</a>
      <a href="#/logout" data-nav="logout">退出</a>
    </nav>
  </div></header>
  <main class="main" id="view">${contentHtml}</main>`;
  // 顶部导航高亮
  const seg = (location.hash.replace('#/', '') || 'posts').split('/')[0];
  document.querySelectorAll('#tb-nav a[data-nav]').forEach((a) => {
    a.classList.toggle('on', a.dataset.nav === seg && seg !== 'logout');
  });
  app.querySelector('#tb-nav').addEventListener('click', (ev) => {
    const a = ev.target.closest('a[href="#/logout"]');
    if (a) {
      ev.preventDefault();
      logout();
    }
  });
  statsBadge();
}
const view = () => document.getElementById('view');

async function logout() {
  try { await API.post('/auth/logout'); } catch (e) { /* ignore */ }
  location.hash = '#/login';
  await boot();
}

// ================= 文章列表 =================
async function viewPosts() {
  pageTitle('文章');
  showLoading();
  shell(`<div class="page-head"><h1>文章管理</h1>
    <div class="spacer">
      <input class="inp" id="p-q" placeholder="搜索标题 / 摘要…" style="width:190px">
      <button class="btn p" id="p-new">＋ 写文章</button>
    </div></div>
    <div class="tabs" id="p-tabs">
      <button data-t="all">全部</button><button data-t="published">已发布</button><button data-t="draft">草稿</button>
    </div>
    <div class="card"><div id="p-list"><div class="loading">加载中…</div></div></div>`);
  let page = 1;
  const qEl = view().querySelector('#p-q');
  const tabsEl = view().querySelector('#p-tabs');

  const syncTabs = () => {
    tabsEl.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.t === listTab));
  };
  const loadList = async () => {
    const listEl = view().querySelector('#p-list');
    listEl.innerHTML = '<div class="loading">加载中…</div>';
    try {
      const qs = new URLSearchParams({ status: listTab, page: String(page), per: '30' });
      if (qEl.value.trim()) qs.set('q', qEl.value.trim());
      const data = await API.get('/posts?' + qs.toString());
      renderRows(listEl, data);
    } catch (e) { listEl.innerHTML = `<div class="empty-note">${esc(e.message)}</div>`; }
  };
  const renderRows = (listEl, data) => {
    if (!data.items.length) {
      listEl.innerHTML = `<div class="empty-note">${listTab === 'all' ? '还没有文章，点右上角「写文章」开始创作。' : listTab === 'draft' ? '暂无草稿' : '还没有已发布文章'}</div>`;
      return;
    }
    const rows = data.items.map((p) => {
      const cat = p.category ? `<a class="cell-sub" href="#/categories">${esc(p.category.name)}</a>` : '';
      const tags = (p.tags || []).map((t) => `<span class="tag-mini">${esc(t.name)}</span>`).join('');
      const st = p.status === 'published' ? '<span class="st published">已发布</span>' : '<span class="st draft">草稿</span>';
      const btnPub = p.status === 'published'
        ? `<button class="btn sm g" data-act="unpub" data-id="${p.id}" data-slug="${esc(p.slug)}">下线</button>`
        : `<button class="btn sm ok" data-act="pub" data-id="${p.id}">发布</button>`;
      const viewL = p.status === 'published' ? `<a class="btn sm g" href="/post/${esc(p.slug)}" target="_blank">查看</a>` : '';
      return `<tr>
        <td><div class="cell-title">${esc(p.title)}${st}</div>
          <div class="cell-sub">${esc('/post/' + p.slug)} ${cat ? ' · ' + cat : ''}</div></td>
        <td>${tags || '<span class="cell-sub">无标签</span>'}</td>
        <td style="white-space:nowrap">${fmtTime(p.published_at || p.updated_at)}</td>
        <td style="white-space:nowrap">${p.view_count || 0} / ${p.comment_count || 0}</td>
        <td style="white-space:nowrap"><a class="btn sm" href="#/posts/${p.id}">编辑</a>${btnPub}${viewL}
          <button class="btn sm d" data-act="del" data-id="${p.id}" data-title="${esc(p.title)}">删除</button></td>
      </tr>`;
    }).join('');
    const pager = data.pages > 1 ? `<div class="pager-line">
      <button class="btn sm" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>‹ 上一页</button>
      <span class="hint">第 ${data.page} / ${data.pages} 页 · 共 ${data.total} 篇</span>
      <button class="btn sm" data-page="${page + 1}" ${page >= data.pages ? 'disabled' : ''}>下一页 ›</button>
    </div>` : `<div class="hint" style="margin-top:12px">共 ${data.total} 篇</div>`;
    listEl.innerHTML = `<div class="tbl-w"><table class="tbl"><thead><tr>
      <th>标题</th><th>标签</th><th>发布时间</th><th>阅读 / 评论</th><th>操作</th></tr></thead>
      <tbody>${rows}</tbody></table></div>${pager}`;
    listEl.querySelectorAll('button[data-act]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const act = btn.dataset.act;
        const id = btn.dataset.id;
        try {
          if (act === 'del') {
            if (!(await confirmDanger(`确定删除《${btn.dataset.title}》？文章、标签关联与评论将一并删除，此操作不可恢复。`, '删除文章'))) return;
            await API.del('/posts/' + id);
            toast('已删除');
          } else if (act === 'pub') {
            await API.post('/posts/' + id + '/publish', { status: 'published' });
            toast('已发布 ✓ 前台 / 分类 / 标签 / 归档 / RSS / 站点地图已同步');
          } else if (act === 'unpub') {
            await API.post('/posts/' + id + '/publish', { status: 'draft' });
            toast('已下线为草稿');
          }
          loadList();
        } catch (e) { toast(e.message, 'bad'); }
      });
    });
    listEl.querySelectorAll('[data-page]').forEach((b) => {
      b.addEventListener('click', () => { page = parseInt(b.dataset.page, 10); loadList(); });
    });
  };
  qEl.addEventListener('input', debounceLocal(() => { page = 1; loadList(); }, 350));
  tabsEl.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-t]');
    if (!b) return;
    listTab = b.dataset.t; page = 1; syncTabs(); loadList();
  });
  view().querySelector('#p-new').addEventListener('click', () => go('#/posts/new'));
  syncTabs();
  loadList();
}
function debounceLocal(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ================= 写文章 / 编辑 =================
async function viewEditor(id) {
  pageTitle(id ? '编辑文章' : '写文章');
  showLoading('加载编辑器…');
  let post = null;
  const cats = (await API.get('/categories').catch(() => []));
  if (id) post = await API.get('/admin/posts/' + id);

  shell(`
  <div class="page-head"><h1>${id ? '编辑文章' : '写文章'}</h1>
    <div class="spacer"><a class="btn g" href="#/posts">← 返回列表</a></div></div>
  <div class="ed-card">
    <div class="ed-title"><input id="e-title" placeholder="在此输入文章标题…" value="${esc(post?.title || '')}"></div>
    <div class="ed-meta">
      <span class="f2">分类
        <select id="e-cat"><option value="">（无分类）</option>
        ${cats.map((c) => `<option value="${c.id}" ${post && post.category_id == c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
        </select></span>
      <span class="f2">标签 <input id="e-tags" placeholder="多个标签用逗号分隔" value="${esc((post?.tags || []).map((t) => t.name).join(',') || '')}"></span>
      <span class="f2">别名 <input id="e-slug" placeholder="留空自动生成（英文数字 -）" value="${esc(post?.slug || '')}">
        <a id="e-slug-rand" href="javascript:;" title="随机生成">🎲</a></span>
      <span class="f2">封面 <input type="file" id="e-cover" accept="image/*" style="max-width:190px">
        <span id="e-cover-prev" style="display:${post?.cover_key ? '' : 'none'}"><img src="/media/${esc(post?.cover_key || '')}" style="height:34px;border-radius:6px;vertical-align:middle">
        <a id="e-cover-del" href="javascript:;" style="margin-left:4px">移除</a></span></span>
      <span id="e-status" class="hint"></span>
    </div>
    <div id="e-host"></div>
    <div class="ed-actions">
      <button class="btn g" id="e-save-draft">保存草稿</button>
      <button class="btn p" id="e-publish">${post ? '保存并更新（保持当前状态）' : '一键发布'}</button>
      <button class="btn v" id="e-preview">预览</button>
      <span class="spacer hint">提示：编辑器所见即所得，正文将保存为 Markdown；发布后自动生成网页、分类/标签/归档页、RSS 与站点地图。快捷键 Ctrl+S 保存草稿。</span>
    </div>
  </div>`);

  const editorHost = view().querySelector('#e-host');
  editor = new Editor(editorHost, { ph: '开始写作…（可粘贴图片，或点工具栏 🖼 上传图片至 R2）' });
  editor.upload = async (file) => {
    const d = await API.upload(file);
    toast('图片已上传');
    return d.url;
  };
  editor.setHTML(post?.content_html || '');

  // 别名随机
  view().querySelector('#e-slug-rand').addEventListener('click', () => {
    view().querySelector('#e-slug').value = 'post-' + Date.now().toString(36);
  });

  // 封面
  let coverKey = post?.cover_key || null;
  const coverPrev = () => {
    const box = view().querySelector('#e-cover-prev');
    box.style.display = coverKey ? '' : 'none';
    if (coverKey) box.querySelector('img').src = '/media/' + coverKey;
  };
  view().querySelector('#e-cover').addEventListener('change', async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    try {
      const d = await API.upload(file);
      coverKey = d.key;
      coverPrev();
      toast('封面已上传');
    } catch (e) { toast(e.message, 'bad'); }
  });
  view().querySelector('#e-cover-del').addEventListener('click', () => { coverKey = null; coverPrev(); });

  const updateStatus = (st) => {
    view().querySelector('#e-status').textContent = st === 'published' ? '当前状态：已发布' : '当前状态：草稿（仅你可见）';
    view().querySelector('#e-status').style.color = st === 'published' ? '#15803d' : '#b45309';
  };
  updateStatus(post ? post.status : 'draft');

  // 防误关（模块级 dirty + 一次性守卫）
  dirty = false;
  const markDirty = () => { dirty = true; };
  ['#e-title', '#e-tags', '#e-slug', '#e-cat'].forEach((s) => view().querySelector(s).addEventListener('input', markDirty));
  editorHost.addEventListener('input', markDirty);
  draftSaver = () => save(false);

  const collect = () => {
    const title = view().querySelector('#e-title').value.trim();
    if (!title) throw new Error('请填写文章标题');
    const md = editor.getMarkdown();
    if (!md) throw new Error('文章内容不能为空');
    const tags = view().querySelector('#e-tags').value.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
    return {
      title,
      content_md: md,
      slug: view().querySelector('#e-slug').value.trim(),
      category_id: view().querySelector('#e-cat').value || null,
      tags,
      cover_key: coverKey,
      excerpt: '',
    };
  };
  const save = async (publish) => {
    const btnPub = view().querySelector('#e-publish');
    btnPub.disabled = true;
    try {
      const body = { ...collect(), status: publish ? 'published' : 'draft' };
      let slug;
      if (id) {
        const r = await API.put('/posts/' + id, body);
        slug = r.slug;
        toast(publish ? '已更新并发布 ✓' : '草稿已保存');
      } else {
        const r = await API.post('/posts', body);
        slug = r.slug;
        toast(publish ? '已发布 ✓ 前台、分类/标签页、RSS、站点地图均已同步' : '草稿已保存');
        dirty = false;
        go('#/posts/' + r.id);
        return;
      }
      dirty = false;
      if (publish) {
        const open = await dialog({
          title: '发布成功',
          bodyHtml: `文章地址：<a href="/post/${esc(slug)}" target="_blank">/post/${esc(slug)}</a><br>
          订阅：<a href="/rss.xml" target="_blank">/rss.xml</a> · <a href="/sitemap.xml" target="_blank">/sitemap.xml</a>`,
          actions: [{ val: 'list', label: '返回列表', cls: 'p' }, { val: 'open', label: '打开文章', cls: 'g' }],
        });
        if (open === 'open') window.open('/post/' + slug, '_blank');
        go('#/posts');
      } else {
        updateStatus('draft');
      }
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      btnPub.disabled = false;
    }
  };
  view().querySelector('#e-save-draft').addEventListener('click', () => save(false));
  view().querySelector('#e-publish').addEventListener('click', () => save(true));
  view().querySelector('#e-preview').addEventListener('click', async () => {
    const pBtn = view().querySelector('#e-preview');
    pBtn.disabled = true;
    try {
      const r = await API.post('/preview', { title: view().querySelector('#e-title').value, content_md: collect().content_md });
      await dialog({
        title: '文章预览（与发布效果一致）',
        bodyHtml: `<iframe style="width:100%;height:66vh;border:1px solid #e3e7ef;border-radius:10px;background:#f6f7f9" sandbox="" srcdoc="${esc(r.html)}"></iframe>`,
        actions: [{ val: 'ok', label: '关闭', cls: 'p' }],
      });
    } catch (e) { toast(e.message, 'bad'); }
    pBtn.disabled = false;
  });

  editor.we.focus();
}

// 全局一次性守卫：未保存提醒 + Ctrl+S 存草稿
let guardsInstalled = false;
function installGuards() {
  if (guardsInstalled) return;
  guardsInstalled = true;
  window.addEventListener('beforeunload', (ev) => {
    if (dirty) { ev.preventDefault(); ev.returnValue = ''; }
  });
  document.addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's' && draftSaver) {
      if (/^#\/posts\/(new|\d+)$/.test(location.hash)) {
        ev.preventDefault();
        draftSaver();
      }
    }
  });
}
// ================= 评论管理 =================
async function viewComments() {
  pageTitle('评论');
  showLoading();
  shell(`<div class="page-head"><h1>评论管理</h1>
    <div class="spacer"><a class="btn g" href="/" target="_blank">查看站点 ↗</a></div></div>
    <div class="tabs" id="c-tabs">
      <button data-t="pending">待审核</button><button data-t="approved">已通过</button><button data-t="trash">回收站</button><button data-t="all">全部</button>
    </div>
    <div id="c-list"><div class="loading">加载中…</div></div>`);

  const load = async () => {
    const box = view().querySelector('#c-list');
    box.innerHTML = '<div class="loading">加载中…</div>';
    try {
      const r = await API.get('/admin/comments?status=' + commentTab);
      view().querySelectorAll('#c-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === commentTab));
      if (!r.items.length) {
        box.innerHTML = `<div class="empty-note">${commentTab === 'pending' ? '太棒了，没有待审核评论 🎉' : '暂无评论'}</div>`;
        return;
      }
      box.innerHTML = r.items.map((c) => {
        const author = c.is_admin ? esc(c.author) + ' <span class="tag-mini">博主</span>' : esc(c.author);
        const st = c.status === 'pending' ? '<span class="st pending">待审核</span>' : c.status === 'trash' ? '<span class="st trash">回收站</span>' : '<span class="st approved">已通过</span>';
        const ops = [];
        if (c.status !== 'approved') ops.push(`<button class="btn sm ok" data-o="app" data-id="${c.id}">通过</button>`);
        if (c.status === 'approved') ops.push(`<button class="btn sm g" data-o="pend" data-id="${c.id}">转待审</button>`);
        if (c.status !== 'trash') ops.push(`<button class="btn sm g" data-o="trash" data-id="${c.id}">垃圾</button>`);
        ops.push(`<button class="btn sm d" data-o="del" data-id="${c.id}">彻底删除</button>`);
        return `<div class="card" style="margin-bottom:12px">
          <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:6px">
            <b>${author}</b>${st}
            <span class="hint">${fmtTime(c.created_at)}${c.ip ? ' · IP ' + esc(c.ip) : ''}</span>
            <span style="margin-left:auto;font-size:13px">${c.post_title ? `评论于 <a href="/post/${esc(c.post_slug)}" target="_blank">《${esc(c.post_title)}》</a>` : '（文章已删除）'}</span>
          </div>
          <div style="color:#374151;white-space:pre-wrap">${esc(c.content)}</div>
          <div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap">${ops.join('')}
            <button class="btn sm v" data-o="reply" data-id="${c.id}">博主回复</button></div>
        </div>`;
      }).join('');
      box.querySelectorAll('button[data-o]').forEach((b) => b.addEventListener('click', async () => {
        const id = b.dataset.id, o = b.dataset.o;
        try {
          if (o === 'app') { await API.patch('/comments/' + id, { status: 'approved' }); toast('已通过'); }
          else if (o === 'pend') { await API.patch('/comments/' + id, { status: 'pending' }); toast('已转为待审核'); }
          else if (o === 'trash') { await API.patch('/comments/' + id, { status: 'trash' }); toast('已移入回收站'); }
          else if (o === 'del') {
            if (!(await confirmDanger('彻底删除该评论？连带其博主回复一并删除。', '删除评论'))) return;
            await API.del('/comments/' + id);
            toast('已删除');
          } else if (o === 'reply') {
            let replyText = '';
            const res = await dialog({
              title: '博主回复',
              bodyHtml: '<div class="field"><label>回复内容（发布后直接展示在原文下）</label><textarea class="txa" id="rp" style="min-height:110px"></textarea></div>',
              actions: [{ val: 'ok', label: '发布回复', cls: 'p' }, { val: 'cancel', label: '取消', cls: 'g' }],
              onSubmit: (body) => {
                replyText = body.querySelector('#rp').value.trim();
                if (replyText.length < 2) return false;
              },
            });
            if (res === 'ok' && replyText) {
              await API.post('/comments/' + id + '/reply', { content: replyText });
              toast('回复已发布');
            }
          }
          load();
        } catch (e) { toast(e.message, 'bad'); }
      }));
    } catch (e) { box.innerHTML = `<div class="empty-note">${esc(e.message)}</div>`; }
  };
  view().querySelector('#c-tabs').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-t]');
    if (!b) return;
    commentTab = b.dataset.t;
    load();
  });
  load();
  statsBadge();
}

// ================= 分类与标签 =================
async function viewCategories() {
  pageTitle('分类与标签');
  showLoading();
  const cats = await API.get('/categories');
  const tags = await API.get('/tags');
  shell(`
  <div class="page-head"><h1>分类与标签</h1></div>
  <div class="grid2">
    <div class="card">
      <div class="sec-title">分类 <small>文章分类（一篇文章一个分类）</small></div>
      <form id="cat-add" style="display:flex;gap:8px;margin-bottom:12px">
        <input class="inp" name="name" placeholder="新分类名称" required style="flex:1">
        <button class="btn p" type="submit">新建</button>
      </form>
      <div id="cat-list"></div>
    </div>
    <div class="card">
      <div class="sec-title">标签 <small>建议在写文章时直接给正文打标签</small></div>
      <div id="tag-list"></div>
    </div>
  </div>`);
  const renderCats = (list) => {
    view().querySelector('#cat-list').innerHTML = !list.length ? '<div class="empty-note">还没有分类</div>' :
      `<div class="tbl-w"><table class="tbl"><thead><tr><th>名称</th><th>文章数</th><th>操作</th></tr></thead><tbody>${
      list.map((c) => `<tr><td><b>${esc(c.name)}</b><div class="cell-sub">/${esc(c.slug)} ${c.description ? '· ' + esc(c.description) : ''}</div></td>
        <td>${c.count}</td><td><button class="btn sm" data-i="${c.id}" data-n="${esc(c.name)}" data-s="${esc(c.slug)}" data-d="${esc(c.description)}" data-cat="1">编辑</button>
        <button class="btn sm d" data-del-cat="${c.id}" data-n="${esc(c.name)}">删除</button></td></tr>`).join('')}
      </tbody></table></div>`;
  };
  const renderTags = (list) => {
    view().querySelector('#tag-list').innerHTML = !list.length ? '<div class="empty-note">还没有标签</div>' :
      `<div class="tbl-w"><table class="tbl"><thead><tr><th>名称</th><th>文章数</th><th>操作</th></tr></thead><tbody>${
      list.map((t) => `<tr><td><b>${esc(t.name)}</b><div class="cell-sub">/${esc(t.slug)}</div></td>
        <td>${t.count}</td><td><button class="btn sm d" data-del-tag="${t.id}" data-n="${esc(t.name)}">删除</button></td></tr>`).join('')}
      </tbody></table></div>`;
  };
  renderCats(cats); renderTags(tags);
  view().querySelector('#cat-add').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const name = new FormData(ev.target).get('name').trim();
    if (!name) return;
    try {
      await API.post('/categories', { name, description: '' });
      toast('分类已创建');
      const list = await API.get('/categories');
      renderCats(list);
      ev.target.reset();
    } catch (e) { toast(e.message, 'bad'); }
  });
  view().querySelector('#cat-list').addEventListener('click', async (ev) => {
    const b = ev.target.closest('button[data-del-cat]');
    if (b) {
      if (!(await confirmDanger(`删除分类「${b.dataset.n}」？其下文章将变为无分类，不会被删除。`, '删除分类'))) return;
      try { await API.del('/categories/' + b.dataset.delCat); toast('已删除'); renderCats(await API.get('/categories')); }
      catch (e) { toast(e.message, 'bad'); }
      return;
    }
    const eb = ev.target.closest('button[data-cat]');
    if (!eb) return;
    const res = await dialog({
      title: '编辑分类',
      bodyHtml: `<div class="field"><label>名称</label><input class="inp" id="cn" value="${eb.dataset.n}"></div>
        <div class="field"><label>别名（URL 用英文数字 -；改动后旧链接失效）</label><input class="inp" id="cs" value="${eb.dataset.s}"></div>
        <div class="field"><label>描述</label><textarea class="txa" id="cd" style="min-height:70px">${eb.dataset.d}</textarea></div>`,
      actions: [{ val: 'ok', label: '保存', cls: 'p' }, { val: 'cancel', label: '取消', cls: 'g' }],
      onSubmit: (body) => {
        const n = body.querySelector('#cn').value.trim();
        if (!n) return false;
      },
    });
    if (res !== 'ok') return;
    const root = document.getElementById('modal-root');
    const mask = root.querySelector('.mask:last-of-type');
    const g = (id) => mask ? mask.querySelector('#' + id).value.trim() : '';
    try {
      await API.put('/categories/' + eb.dataset.i, { name: g('cn'), slug: g('cs'), description: g('cd') });
      toast('已保存');
      renderCats(await API.get('/categories'));
    } catch (e) { toast(e.message, 'bad'); }
  });
  view().querySelector('#tag-list').addEventListener('click', async (ev) => {
    const b = ev.target.closest('button[data-del-tag]');
    if (!b) return;
    if (!(await confirmDanger(`删除标签「${b.dataset.n}」？文章内容不会被删除。`, '删除标签'))) return;
    try { await API.del('/tags/' + b.dataset.delTag); toast('已删除'); renderTags(await API.get('/tags')); }
    catch (e) { toast(e.message, 'bad'); }
  });
}

// ================= 图片库 =================
async function viewMedia() {
  pageTitle('图片库');
  showLoading();
  shell(`<div class="page-head"><h1>图片库</h1>
    <div class="spacer"><button class="btn p" id="m-up">＋ 上传图片</button>
    <input type="file" id="m-file" accept="image/png,image/jpeg,image/gif,image/webp,image/avif,image/bmp" hidden></div></div>
    <div id="m-grid"><div class="loading">加载中…</div></div>`);
  const box = view().querySelector('#m-grid');
  const load = async (cursor) => {
    try {
      const r = await API.get('/media' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''));
      if (!r.items.length) {
        box.innerHTML = '<div class="empty-note">还没有图片。写文章时点编辑器 🖼 按钮，图片会自动存入 R2。</div>';
        return;
      }
      box.innerHTML = `<div class="mg">${r.items.map((m) => `
        <div class="mg-it"><img src="${esc(m.url)}" loading="lazy" alt="">
          <div class="mi-meta">${fmtSize(m.size)}<br>${fmtTime(String(m.uploaded).slice(0, 19).replace('T', ' '))}</div>
          <div class="mi-ops"><button class="btn sm" data-copy="${esc(m.url)}">复制链接</button>
          <button class="btn sm d" data-del="${esc(m.key)}">删除</button></div></div>`).join('')}</div>
        ${r.truncated ? `<div style="margin-top:14px"><button class="btn" id="m-more">加载更多</button></div>` : ''}`;
      box.querySelectorAll('button[data-copy]').forEach((b) => b.addEventListener('click', () => {
        navigator.clipboard.writeText(location.origin + b.dataset.copy).then(() => toast('链接已复制'));
      }));
      box.querySelectorAll('button[data-del]').forEach((b) => b.addEventListener('click', async () => {
        if (!(await confirmDanger('删除该图片？文中引用的图片将无法显示（文章正文不受影响）。', '删除图片'))) return;
        try { await API.del('/media?key=' + encodeURIComponent(b.dataset.del)); toast('已删除'); load(); }
        catch (e) { toast(e.message, 'bad'); }
      }));
      const more = box.querySelector('#m-more');
      if (more) more.addEventListener('click', () => load(r.cursor));
    } catch (e) { box.innerHTML = `<div class="empty-note">${esc(e.message)}</div>`; }
  };
  view().querySelector('#m-up').addEventListener('click', () => view().querySelector('#m-file').click());
  view().querySelector('#m-file').addEventListener('change', async (ev) => {
    const file = ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    try {
      await API.upload(file);
      toast('上传成功');
      load();
    } catch (e) { toast(e.message, 'bad'); }
  });
  load();
}

// ================= 主题外观 =================
async function viewThemes() {
  pageTitle('主题');
  showLoading();
  shell(`
  <div class="page-head"><h1>主题外观</h1>
    <div class="spacer">
      <input type="file" id="t-dir" webkitdirectory multiple hidden>
      <button class="btn p" id="t-pick">＋ 安装新主题</button>
    </div>
  </div>
  <div class="card" id="t-drop" style="border-style:dashed;text-align:center;color:#6b7280;padding:14px;cursor:pointer;margin-bottom:14px">
    把整个主题文件夹拖到这里安装（文件夹内需含 <code>theme.json</code> 与 <code>style.css</code>）；也可以点上方「＋ 安装新主题」选择文件夹。
  </div>
  <div id="t-list"><div class="loading">加载中…</div></div>`);

  const v = view();
  const listEl = v.querySelector('#t-list');
  const dropEl = v.querySelector('#t-drop');
  let themes = [];

  const themeIdOf = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const cardHtml = (t) => {
    const shot = t.builtin
      ? '<div style="height:108px;background:linear-gradient(135deg,#f3f6ff,#e6f1fb);display:flex;align-items:center;justify-content:center;color:#185FA5;font-size:22px;font-weight:700">默认</div>'
      : `<img src="/theme-assets/${esc(t.id)}/preview.png" alt="" loading="lazy" style="width:100%;height:108px;object-fit:cover;display:block" onerror="this.style.display='none';this.insertAdjacentHTML('afterend','<div style=\\'height:108px;background:#eef2ff;display:flex;align-items:center;justify-content:center;color:#185FA5;font-size:26px;font-weight:700\\'>${esc((t.name || t.id).slice(0, 1))}</div>')">`;
    const meta = `<div style="padding:10px 12px">
      <div style="display:flex;align-items:center;gap:8px"><b style="font-size:14.5px">${esc(t.name)}</b>
        ${t.builtin ? '<span style="font-size:11px;background:#eef1f5;color:#5f5e5a;padding:1px 8px;border-radius:99px">内置</span>' : ''}
        ${t.active ? '<span style="font-size:11px;background:#15803d;color:#fff;padding:1px 8px;border-radius:99px">使用中</span>' : ''}
      </div>
      <div style="font-size:12px;color:#6b7280;margin-top:2px">${esc(t.author || '佚名')}${t.version ? ' · v' + esc(t.version) : ''}${t.builtin ? '' : ' · ' + esc(t.id)}</div>
      ${t.description ? `<div style="font-size:12.5px;color:#4b5563;margin-top:6px;line-height:1.5">${esc(t.description)}</div>` : ''}
      <div style="margin-top:10px;display:flex;gap:6px">
        ${t.active ? '' : `<button class="btn sm p" data-act="${esc(t.id)}">启用</button>`}
        ${t.builtin ? '' : `<button class="btn sm d" data-del="${esc(t.id)}">删除</button>`}
      </div></div>`;
    return `<div class="card" style="margin:0;overflow:hidden;padding:0;${t.active ? 'outline:2px solid #2563eb' : ''}">${shot}${meta}</div>`;
  };
  const render = (data) => {
    listEl.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(248px,1fr));gap:14px">${data.items.map(cardHtml).join('')}</div>
    <p class="hint">启用主题后，打开前台任意页面即可看到新外观；正在使用的主题被删除时会自动恢复「系统默认」。设计主题的方法见 README 的《主题设计指南》。</p>`;
    listEl.querySelectorAll('button[data-act]').forEach((b) => b.addEventListener('click', async () => {
      const id = b.dataset.act;
      try {
        const r = await API.post('/themes/activate', { id });
        toast('已启用主题：' + r.active);
        load();
      } catch (e) { toast(e.message, 'bad'); }
    }));
    listEl.querySelectorAll('button[data-del]').forEach((b) => b.addEventListener('click', async () => {
      const t = themes.find((x) => x.id === b.dataset.del);
      if (!t) return;
      if (!(await confirmDanger(`确定删除主题「${t.name}」吗？其全部文件将从 R2 移除。${t.active ? '\n\n该主题正在使用中，删除后将自动回退为系统默认外观。' : ''}`, '删除主题'))) return;
      try {
        const r = await API.del('/themes/' + t.id);
        toast('已删除主题' + (r.activeFallback ? '（当前主题已回退为系统默认）' : ''));
        load();
      } catch (e) { toast(e.message, 'bad'); }
    }));
  };
  const load = async () => {
    try {
      const data = await API.get('/themes');
      themes = data.items;
      render(data);
    } catch (e) { listEl.innerHTML = `<div class="empty-note">${esc(e.message)}</div>`; }
  };

  // 安装：items = [{file, rel}]，rel 为相对主题根目录的路径
  const install = async (items) => {
    if (!items.length) return;
    const metaItem = items.find((x) => x.rel === 'theme.json');
    const cssItem = items.find((x) => x.rel === 'style.css');
    if (!metaItem || !cssItem) { toast('主题文件夹必须包含 theme.json 与 style.css', 'bad'); return; }
    let meta = {};
    try { meta = JSON.parse(await metaItem.file.text()); } catch (e) { toast('theme.json 不是有效的 JSON', 'bad'); return; }
    const id = themeIdOf(meta.id);
    if (!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(id) || id === 'default') {
      toast('请在 theme.json 中填写合法的 id（小写字母 / 数字 / 连字符，且不能为 default）', 'bad');
      return;
    }
    const name = String(meta.name || id).slice(0, 60);
    const exists = themes.find((t) => t.id === id && !t.builtin);
    if (exists) {
      const c = await dialog({
        title: '覆盖安装主题',
        bodyHtml: `<p>已存在主题「${esc(exists.name)}」（${esc(id)}），继续将覆盖它的全部文件。</p><p class="hint">若该主题正在使用，覆盖保存后刷新前台页面即可生效。</p>`,
        actions: [{ val: 'ok', label: '继续覆盖', cls: 'd' }, { val: 'cancel', label: '取消', cls: 'g' }],
      });
      if (c !== 'ok') return;
    }
    const total = items.length;
    let done = 0;
    const btn = v.querySelector('#t-pick');
    btn.disabled = true;
    btn.textContent = `上传中 0/${total} …`;
    try {
      for (const it of items) {
        if (!it.rel) continue;
        await API.uploadThemeFile(it.file, id, it.rel);
        done++;
        btn.textContent = `上传中 ${done}/${total} …`;
      }
      toast('主题「' + name + '」安装完成，可点「启用」立即换肤');
      load();
    } catch (e) {
      toast('上传中断：' + e.message + '（可重试一次覆盖安装）', 'bad');
      load();
    }
    btn.disabled = false;
    btn.textContent = '＋ 安装新主题';
  };

  v.querySelector('#t-pick').addEventListener('click', () => v.querySelector('#t-dir').click());
  v.querySelector('#t-dir').addEventListener('change', (ev) => {
    const files = [...ev.target.files];
    ev.target.value = '';
    const root = (files[0] && files[0].webkitRelativePath || '').split('/')[0];
    const items = files
      .filter((f) => f.webkitRelativePath)
      .map((f) => ({ file: f, rel: f.webkitRelativePath.split('/').slice(1).join('/') }))
      .filter((x) => x.rel);
    if (!root || !items.length) { toast('请通过「选择文件夹」方式上传（需保留目录结构）', 'bad'); return; }
    install(items);
  });

  // 拖拽整文件夹安装（Chrome / Edge）
  const readDir = async (entry, base) => {
    const out = [];
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const en of batch) {
        const p = base ? base + '/' + en.name : en.name;
        if (en.isDirectory) out.push(...(await readDir(en, p)));
        else if (en.isFile) {
          const f = await new Promise((res, rej) => en.file(res, rej));
          out.push({ file: f, rel: p });
        }
      }
    }
    return out;
  };
  const onDrop = async (ev) => {
    ev.preventDefault();
    dropEl.style.borderColor = '';
    try {
      const entries = [...(ev.dataTransfer ? ev.dataTransfer.items : [])]
        .map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null)).filter(Boolean);
      if (!entries.length) { toast('请直接拖入整个主题文件夹', 'bad'); return; }
      const all = [];
      for (const e of entries) all.push(...(await readDir(e, '')));
      const rootDirs = new Set(all.map((x) => x.rel.split('/')[0]));
      const items = rootDirs.size === 1 ? all.map((x) => ({ file: x.file, rel: x.rel.split('/').slice(1).join('/') })) : all;
      if (!items.some((x) => x.rel === 'theme.json')) { toast('拖入的文件夹中未找到 theme.json', 'bad'); return; }
      install(items);
    } catch (e) {
      dropEl.style.borderColor = '';
      toast('无法读取该文件夹，请改用「＋ 安装新主题」按钮选择文件夹', 'bad');
    }
  };
  ['dragover', 'dragenter'].forEach((t) => dropEl.addEventListener(t, (ev) => { ev.preventDefault(); dropEl.style.borderColor = '#2563eb'; }));
  ['dragleave', 'drop'].forEach((t) => dropEl.addEventListener(t, (ev) => { if (t !== 'drop') { ev.preventDefault(); dropEl.style.borderColor = ''; } }));
  dropEl.addEventListener('drop', onDrop);

  load();
}

// ================= 备份与恢复 =================
async function viewBackup() {
  pageTitle('备份与恢复');
  showLoading();
  shell(`<div class="page-head"><h1>备份与恢复</h1></div>
  <div class="card">
    <div class="sec-title">一键备份 <small>整站数据（文章 / 分类 / 标签 / 评论 / 设置）导出为 JSON</small></div>
    <p class="hint" style="margin-top:0">备份文件存放在 Cloudflare R2 的 backups/ 目录，最多保留最近 20 份。图片本身就在 R2 中，无需重复备份。</p>
    <button class="btn p" id="b-now">⚡ 立即备份到 R2</button>
    <button class="btn g" id="b-dl">导出并下载到本地</button>
    <input type="file" id="b-file" accept="application/json,.json" hidden>
    <button class="btn g" id="b-up">从本地上传备份恢复</button>
    <span class="hint" style="margin-left:8px">也可在 Cloudflare 控制台为该项目配置定时任务实现每日自动备份（见 README）。</span>
  </div>
  <div class="card"><div class="sec-title">R2 中的备份</div><div id="b-list"><div class="loading">加载中…</div></div></div>`);

  const listBox = view().querySelector('#b-list');
  const render = (items) => {
    if (!items.length) { listBox.innerHTML = '<div class="empty-note">暂无备份</div>'; return; }
    listBox.innerHTML = `<div class="tbl-w"><table class="tbl"><thead><tr><th>文件</th><th>大小</th><th>备份时间</th><th>操作</th></tr></thead><tbody>${
      items.map((it) => `<tr><td><code>${esc(it.name)}</code></td><td>${fmtSize(it.size)}</td>
        <td>${fmtTime(String(it.uploaded).slice(0, 19).replace('T', ' '))}</td>
        <td><button class="btn sm g" data-dl="${esc(it.name)}">下载</button>
        <button class="btn sm d" data-restore="${esc(it.name)}">恢复</button></td></tr>`).join('')}
      </tbody></table></div>`;
    listBox.querySelectorAll('button[data-dl]').forEach((b) => b.addEventListener('click', () => {
      window.open('/api/backup/' + b.dataset.dl, '_blank');
    }));
    listBox.querySelectorAll('button[data-restore]').forEach((b) => b.addEventListener('click', async () => {
      if (!(await confirmDanger(
        `将用「${b.dataset.restore}」覆盖当前全部内容（文章、分类、标签、评论与站点设置）。管理员账号保留。\n\n强烈建议先做一次新备份再恢复。`, '恢复备份（覆盖现有数据）'))) return;
      try {
        const r = await API.post('/backup/restore', { key: 'backups/' + b.dataset.restore });
        toast('恢复完成，共写入 ' + (r.restored || 0) + ' 条记录');
        load();
      } catch (e) { toast(e.message, 'bad'); }
    }));
  };
  const load = async () => {
    try { render((await API.get('/backups')).items); }
    catch (e) { listBox.innerHTML = `<div class="empty-note">${esc(e.message)}</div>`; }
  };
  view().querySelector('#b-now').addEventListener('click', async () => {
    const btn = view().querySelector('#b-now');
    btn.disabled = true;
    try { const r = await API.post('/backup'); toast('备份完成：' + r.key); load(); }
    catch (e) { toast(e.message, 'bad'); }
    btn.disabled = false;
  });
  view().querySelector('#b-dl').addEventListener('click', async () => {
    const r = await fetch('/api/backup', { method: 'POST', credentials: 'same-origin' });
    const data = await r.json();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'blog-backup-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
  });
  view().querySelector('#b-up').addEventListener('click', () => view().querySelector('#b-file').click());
  view().querySelector('#b-file').addEventListener('change', async (ev) => {
    const file = ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!(await confirmDanger(`将用本地文件「${file.name}」覆盖当前全部内容。`, '从本地上传恢复'))) return;
      const r = await API.post('/backup/restore', { data });
      toast('恢复完成，共写入 ' + (r.restored || 0) + ' 条记录');
    } catch (e) { toast(e.message === 'Unexpected token' ? '备份文件格式不正确' : e.message, 'bad'); }
  });
  load();
}

// ================= 设置 =================
async function viewSettings() {
  pageTitle('设置');
  showLoading();
  const all = await API.get('/posts?status=published&per=1');
  shell(`
  <div class="page-head"><h1>站点设置</h1></div>
  <form id="set-form">
  <div class="grid2">
    <div class="card">
      <div class="sec-title">站点信息</div>
      <div class="field"><label>站点名称</label><input class="inp" name="site_title" id="s-site_title"></div>
      <div class="field"><label>副标题</label><input class="inp" name="site_subtitle" id="s-site_subtitle"></div>
      <div class="field"><label>作者署名（页脚与文章署名）</label><input class="inp" name="author_name" id="s-author_name"></div>
      <div class="field"><label>SEO 描述</label><input class="inp" name="seo_desc" id="s-seo_desc" placeholder="用于搜索引擎摘要"></div>
      <div class="field"><label>主题色</label><input class="inp" type="color" name="accent" id="s-accent" style="width:120px;height:40px;padding:4px"></div>
      <div class="field"><label>每页文章数</label><input class="inp" type="number" min="1" max="20" name="per_page" id="s-per_page" style="width:120px"></div>
      <div class="field"><label>页脚自定义文字（可留空，支持换行）</label><textarea class="txa" name="footer_text" id="s-footer_text"></textarea></div>
    </div>
    <div>
      <div class="card">
        <div class="sec-title">评论设置</div>
        <label style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><input type="checkbox" id="s-allow"> 允许读者发表评论</label>
        <label style="display:flex;align-items:center;gap:8px"><input type="checkbox" id="s-audit"> 评论先审后发（推荐开启，防垃圾）</label>
        <p class="hint" style="margin-bottom:0">评论内置在系统内，无需外挂 Disqus / Waline。后台可直接审核、回复与删除。</p>
      </div>
      <div class="card">
        <div class="sec-title">对外订阅与收录</div>
        <p class="hint" style="margin-top:0">发布文章后以下地址自动更新，无需任何操作：</p>
        <div class="field"><label>RSS 订阅</label><input class="inp" readonly value="${esc(location.origin)}/rss.xml" onfocus="this.select()"></div>
        <div class="field"><label>站点地图（提交给搜索引擎）</label><input class="inp" readonly value="${esc(location.origin)}/sitemap.xml" onfocus="this.select()"></div>
        <div class="field"><label>站点主页</label><input class="inp" readonly value="${esc(location.origin)}" onfocus="this.select()"></div>
      </div>
      <div class="card">
        <div class="sec-title">修改登录密码</div>
        <div style="display:flex;gap:10px">
          <div class="field" style="flex:1"><label>新密码（留空则不修改）</label><input class="inp" type="password" name="new_password" id="s-pw" autocomplete="new-password"></div>
          <div class="field" style="flex:1"><label>确认新密码</label><input class="inp" type="password" id="s-pw2" autocomplete="new-password"></div>
        </div>
      </div>
    </div>
  </div>
  <div class="card"><button class="btn p" type="submit">保存全部设置</button>
    <span class="hint" style="margin-left:10px">设置即时生效：前台主题、订阅地址与页面内容将同步更新。</span></div>
  </form>`);
  const v = view();
  const data = await (async () => {
    // 读取设置由 PATCH 不返回，这里直接读取 /api/posts 拿不到 settings —— 改用隐藏接口读取
    return null;
  })();
  void data; void all;
  // 通过独立的 settings GET 接口不可用；从已知端点补充：复用 dump? 简化：这里调用一个轻量只读接口
  const sRaw = await fetch('/api/settings/read', { credentials: 'same-origin' });
  const s = sRaw.ok ? await sRaw.json() : {};
  const set = (id, val) => { const e = v.querySelector('#' + id); if (e && val != null) e.value = val; };
  set('s-site_title', s.site_title); set('s-site_subtitle', s.site_subtitle);
  set('s-author_name', s.author_name); set('s-seo_desc', s.seo_desc);
  set('s-accent', s.accent || '#2563eb'); set('s-per_page', s.per_page || '8');
  set('s-footer_text', s.footer_text);
  v.querySelector('#s-allow').checked = s.allow_comments !== '0';
  v.querySelector('#s-audit').checked = s.comment_audit !== '0';

  v.querySelector('#set-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const pw = v.querySelector('#s-pw').value;
    const pw2 = v.querySelector('#s-pw2').value;
    if (pw !== pw2) { toast('两次输入的新密码不一致', 'bad'); return; }
    const body = {
      site_title: v.querySelector('#s-site_title').value,
      site_subtitle: v.querySelector('#s-site_subtitle').value,
      author_name: v.querySelector('#s-author_name').value,
      seo_desc: v.querySelector('#s-seo_desc').value,
      accent: v.querySelector('#s-accent').value,
      per_page: v.querySelector('#s-per_page').value,
      footer_text: v.querySelector('#s-footer_text').value,
      allow_comments: v.querySelector('#s-allow').checked,
      comment_audit: v.querySelector('#s-audit').checked,
    };
    if (pw) body.new_password = pw;
    try {
      await API.patch('/settings', body);
      toast('设置已保存，前台已同步更新');
      v.querySelector('#s-pw').value = '';
      v.querySelector('#s-pw2').value = '';
    } catch (e) { toast(e.message, 'bad'); }
  });
}

// ================= 路由 =================
async function router() {
  if (!state.authed) { viewLogin(); return; }
  const hash = location.hash.replace(/^#\/?/, '');
  const seg = hash.split('/');
  try {
    if (hash === 'login' || hash === '') { if (!state.authed) viewLogin(); else { listTab = 'all'; await viewPosts(); } return; }
    if (seg[0] === 'posts' && seg.length === 1) { await viewPosts(); return; }
    if (seg[0] === 'posts' && seg[1] === 'new') { await viewEditor(null); return; }
    if (seg[0] === 'posts' && /^\d+$/.test(seg[1] || '')) { await viewEditor(parseInt(seg[1], 10)); return; }
    if (seg[0] === 'comments') { await viewComments(); return; }
    if (seg[0] === 'categories') { await viewCategories(); return; }
    if (seg[0] === 'media') { await viewMedia(); return; }
    if (seg[0] === 'themes') { await viewThemes(); return; }
    if (seg[0] === 'backup') { await viewBackup(); return; }
    if (seg[0] === 'settings') { await viewSettings(); return; }
    if (seg[0] === 'logout') { await logout(); return; }
    go('#/posts');
  } catch (e) {
    if (e.code === 401) return;
    showLoading();
    app.innerHTML = `<div class="empty-note">页面加载失败：${esc(e.message)}</div>`;
  }
}

// ---------- 启动 ----------
async function boot() {
  installGuards();
  try {
    const st = await API.get('/state');
    state = { installed: !!st.installed, authed: !!st.authed, username: st.username || '' };
  } catch (e) {
    app.innerHTML = `<div class="empty-note">无法连接服务：${esc(e.message)}</div>`;
    return;
  }
  if (!state.installed) { viewSetup(); return; }
  window.addEventListener('hashchange', router);
  await router();
}
boot();

// ============================================================
// 博客后台单页应用入口：鉴权 -> 布局 -> Hash 路由 -> 各管理视图
// ============================================================
import { API } from './api.js';
import { esc, el, toast, dialog, confirmDanger, fmtSize, fmtTime, busy } from './ui.js';
import { Editor } from './editor.js';
import { dashboardHtml, bindDashboard } from './dashboard.js';

const app = document.getElementById('app');
let state = { installed: true, authed: false, username: '' };
let listTab = 'all';       // 文章列表当前筛选（全部 / 已发布 / 草稿）
let pageTab = 'all';       // 独立页面列表当前筛选
let commentTab = 'pending';
let editor = null; // 当前编辑器实例
let dirty = false; // 文章是否有未保存修改（全局守卫用）
let draftSaver = null; // 由编辑器页注入的“保存草稿”函数（Ctrl+S 用）

// ---------- 主题色：让后台配色跟着设置走 ----------
// 后台 CSS 用的是 --ac 系列变量（前台是 --accent），此前只写死在 :root 里，
// 结果设置页改了主题色后台纹丝不动，只有动态 favicon 变了——因为它由服务端
// 直接取设置值渲染，压根不走 CSS 变量。故后台登录后拉一次设置并写到 :root 上。
// 混白比例与服务端 site.js 的 accentVars() 对齐，前后台观感才一致。
function applyAccent(hex) {
  const c = /^#[0-9a-fA-F]{6}$/.test(String(hex || '')) ? hex : '#2563eb';
  const r = parseInt(c.slice(1, 3), 16), g = parseInt(c.slice(3, 5), 16), b = parseInt(c.slice(5, 7), 16);
  const mix = (t) => `rgb(${Math.round(r + (255 - r) * t)},${Math.round(g + (255 - g) * t)},${Math.round(b + (255 - b) * t)})`;
  const st = document.documentElement.style;
  st.setProperty('--ac', c);
  st.setProperty('--ac-soft', mix(0.94));
  st.setProperty('--ac-soft-2', mix(0.9));
  st.setProperty('--ac-line', mix(0.86));
  st.setProperty('--ac-ring', `rgba(${r},${g},${b},.12)`);
  return c;
}

// ---------- 邮件服务商预设（与 functions/_lib/mail.js 的 MAIL_PROVIDERS 对应） ----------
// 选服务商后自动填服务器 / 端口 / 加密方式，并把「授权码」提示显示出来
// ports / secures = 该服务商**实际开放**的端口与加密方式（按各家官方帮助文档核对，2026-09）。
// 必须写明的原因：不少邮箱只开放其中一种，选错就是连不上，表现为握手超时而非报错。
// ⚠️ 网易 163 / 126 / Yeah、阿里云都**不开 587**；Office365 反过来**不支持 465**。
// ⚠️ 163 / Yeah 还有个 994 端口，也是隐式 SSL，跟 465 等价。
// 注：端口 / 加密方式不写进 how —— 统一由 syncMail() 从 ports / secures 生成，
// 附在授权码提示后面。两处各写一份会改漏，也会把这一行撑得又长又挤。
const MAIL_PROVIDERS = [
  { id: '163', name: '网易 163 邮箱', host: 'smtp.163.com', port: 465, secure: 'ssl',
    ports: [465, 994], secures: ['ssl'],
    how: '163 网页版 → 设置 → POP3/SMTP/IMAP → 开启 SMTP 服务 → 拿到授权码' },
  { id: '126', name: '网易 126 邮箱', host: 'smtp.126.com', port: 465, secure: 'ssl',
    ports: [465], secures: ['ssl'],
    how: '126 网页版 → 设置 → POP3/SMTP/IMAP → 开启 SMTP 服务' },
  { id: 'yeah', name: '网易 Yeah.net', host: 'smtp.yeah.net', port: 465, secure: 'ssl',
    ports: [465, 994], secures: ['ssl'],
    how: '获取方式同 163 邮箱' },
  { id: 'qq', name: 'QQ 邮箱', host: 'smtp.qq.com', port: 465, secure: 'ssl',
    ports: [465, 587], secures: ['ssl', 'starttls'],
    how: 'QQ 邮箱 → 设置 → 账号 → 开启 IMAP/SMTP 服务 → 发短信后生成 16 位授权码' },
  { id: 'foxmail', name: 'Foxmail 邮箱', host: 'smtp.foxmail.com', port: 465, secure: 'ssl',
    ports: [465, 587], secures: ['ssl', 'starttls'],
    how: '获取方式与 QQ 邮箱相同' },
  { id: 'gmail', name: 'Gmail', host: 'smtp.gmail.com', port: 465, secure: 'ssl',
    ports: [465, 587], secures: ['ssl', 'starttls'],
    how: '需先开启两步验证，再生成「应用专用密码」（16 位），不能用 Google 账号密码' },
  { id: 'outlook', name: 'Outlook / Office 365', host: 'smtp.office365.com', port: 587, secure: 'starttls',
    ports: [587], secures: ['starttls'],
    how: '开了两步验证要用「应用密码」，且需在账户设置里启用 SMTP AUTH' },
  { id: 'aliyun', name: '阿里云邮箱', host: 'smtp.aliyun.com', port: 465, secure: 'ssl',
    ports: [465], secures: ['ssl'],
    how: '邮箱设置里开启 SMTP 服务，可用邮箱密码或单独设置的「三方客户端密码」' },
  { id: 'exmail', name: '腾讯企业邮', host: 'smtp.exmail.qq.com', port: 465, secure: 'ssl',
    ports: [465, 587], secures: ['ssl', 'starttls'],
    how: '在企业邮后台生成「客户端专用密码」' },
  { id: 'custom', name: '自定义', host: '', port: 465, secure: 'ssl',
    ports: [], secures: ['ssl', 'starttls'],
    how: '按服务商要求填写；多数国内邮箱要的是「授权码 / 客户端专用密码」而非登录密码' },
];
const MAIL_TEMPLATES = [
  { id: 'card', name: '卡片式（推荐）', desc: '带站点头部、引用块与按钮的 HTML 邮件，手机上也好读' },
  { id: 'plain', name: '纯文本', desc: '无 HTML 无样式，兼容性最好，最不容易进垃圾箱' },
  { id: 'minimal', name: '极简一行', desc: '只有一句摘要加一个链接，最短，适合当提醒看' },
];
// 这些服务商必须填「授权码 / 专用密码」，不能填登录密码 —— 这是最常见的配置失败原因
const MAIL_AUTH_CODE = ['163', '126', 'yeah', 'qq', 'foxmail', 'gmail', 'exmail'];

// ---------- 工具 ----------
function pageTitle(t) { document.title = (t ? t + ' · ' : '') + '博客管理后台'; }
// 上传提示：若图片已被转成 WebP，附上体积变化（d._webp 由 API.upload 写入）
function webpNote(d) {
  const w = d && d._webp;
  if (!w || !w.from) return '';
  const pct = Math.round((1 - w.to / w.from) * 100);
  return pct > 0 ? ` · 已转 WebP（${fmtSize(w.from)} → ${fmtSize(w.to)}，省 ${pct}%）` : ' · 已转 WebP';
}
async function statsBadge() {
  try {
    const st = await API.get('/stats');
    const elBadge = document.getElementById('badge-pending');
    if (elBadge) {
      elBadge.textContent = st.pending || '';
      elBadge.style.display = st.pending > 0 ? '' : 'none';
    }
    // 待审友链申请也挂个角标（stats 接口不含友链，单独取一次计数）
    const lr = await API.get('/links?status=pending').catch(() => null);
    const n = (lr && lr.counts && lr.counts.pending) || 0;
    const lk = document.getElementById('badge-links');
    if (lk) { lk.textContent = n || ''; lk.style.display = n ? '' : 'none'; }
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
    <h1><span class="brand-mark">云</span>博客管理后台</h1>
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
      location.hash = '#/dashboard';
      await boot();
    } catch (e) { errEl.textContent = e.message; }
  });
}

function viewSetup() {
  pageTitle('初始化');
  app.innerHTML = `
  <div class="auth-wrap"><div class="auth-card">
    <div id="setup-logo" style="width:44px;height:44px;border-radius:11px;background:#2563eb;color:#fff;display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:800;margin:0 auto 12px">云</div>
    <h1>欢迎使用博客系统</h1>
    <p class="sub">首次部署：填写站点信息并创建管理员账号（仅本次可用）</p>
    <form id="st">
      <div class="field"><label>站点名称</label><input class="inp" name="site_title" value="我的博客" maxlength="60" required></div>
      <div class="field"><label>副标题（首页大字标语）</label><input class="inp" name="site_subtitle" value="记录 · 思考 · 分享" maxlength="80"></div>
      <div style="display:flex;gap:14px">
        <div class="field" style="flex:1"><label>作者署名</label><input class="inp" name="author_name" value="博主" maxlength="30"></div>
        <div class="field" style="flex:1"><label>博主邮箱（选填）</label><input class="inp" name="email" type="email" placeholder="name@example.com" autocomplete="email"></div>
      </div>
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
  const logoEl = app.querySelector('#setup-logo');
  const titleIn = app.querySelector('#st [name="site_title"]');
  // 预览方块底色固定品牌蓝（与实际页头/favicon 一致），只有站名首字会跟着输入变
  const syncLogo = () => {
    logoEl.textContent = (titleIn.value || '').trim()[0] || '云';
  };
  titleIn.addEventListener('input', syncLogo);
  syncLogo();
  app.querySelector('#st').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const errEl = app.querySelector('#st-err');
    errEl.textContent = '';
    const fd = new FormData(ev.target);
    if (fd.get('password') !== fd.get('password2')) { errEl.textContent = '两次输入的密码不一致'; return; }
    // 邮箱选填，只校验格式（与后端 isEmail 同一套规则）
    const em = String(fd.get('email') || '').trim();
    if (em && !/^[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/.test(em)) {
      errEl.textContent = '邮箱格式不正确（示例：name@example.com）'; return;
    }
    try {
      await API.post('/setup', Object.fromEntries(fd.entries()));
      toast('初始化完成，欢迎使用');
      location.hash = '#/dashboard';
      await boot();
    } catch (e) { errEl.textContent = e.message; }
  });
}

// ---------- 主布局 ----------
function shell(contentHtml) {
  app.innerHTML = `
  <header class="topbar"><div class="tb-in">
    <a class="tb-brand" href="#/dashboard"><span class="brand-mark">云</span>博客后台</a>
    <nav class="tb-nav" id="tb-nav">
      <a href="#/dashboard" data-nav="dashboard">仪表盘</a>
      <a href="#/posts" data-nav="posts">文章</a>
      <a href="#/pages" data-nav="pages">页面</a>
      <a href="#/comments" data-nav="comments">评论<span class="badge" id="badge-pending" style="display:none"></span></a>
      <a href="#/links" data-nav="links">朋友<span class="badge" id="badge-links" style="display:none"></span></a>
      <a href="#/categories" data-nav="categories">分类</a>
      <a href="#/tags" data-nav="tags">标签</a>
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
  // 顶部导航高亮（未指定 hash 时默认落在仪表盘）
  const seg = (location.hash.replace('#/', '') || 'dashboard').split('/')[0];
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

// ================= 仪表盘（后台首页） =================
async function viewDashboard() {
  pageTitle('仪表盘');
  showLoading();
  const load = async () => {
    try {
      const d = await API.get('/dashboard');
      shell(dashboardHtml(d, state.username));
      bindDashboard(view(), load);
      statsBadge();
    } catch (e) {
      if (e.code === 401) throw e;
      shell(`<div class="empty-note">仪表盘加载失败：${esc(e.message)}</div>`);
    }
  };
  await load();
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
    // 置顶文章在后端就排在最前，这里按出现顺序编号：1 = 优先级最高（也可以直接看列表上下位置）
    let pinSeq = (data.page - 1) * data.per;
    const rows = data.items.map((p) => {
      if (p.pinned) pinSeq += 1;
      const rank = pinSeq;
      const cat = p.category ? `<a class="cell-sub" href="#/categories">${esc(p.category.name)}</a>` : '';
      const tags = (p.tags || []).map((t) => `<span class="tag-mini">${esc(t.name)}</span>`).join('');
      const st = p.status === 'published' ? '<span class="st published">已发布</span>' : '<span class="st draft">草稿</span>';
      const lockTag = p.locked ? '<span class="tag-mini lock">🔒 加密</span>' : '';
      // 置顶操作：已置顶的给「上移 / 下移 / 取消」，未置顶的给一个「置顶」按钮。
      // 草稿不给置顶入口——前台本来就看不到它，占了优先级反而像置顶失效了。
      const btnPin = p.pinned
        ? `<span class="pin-tag" title="置顶优先级：第 ${rank} 位，列表自上而下即由高到低">📌 置顶 #${rank}</span>
           <button class="btn sm pin-arrow" data-act="pinup" data-id="${p.id}" title="上移一位（优先级更高）">↑</button>
           <button class="btn sm pin-arrow" data-act="pindown" data-id="${p.id}" title="下移一位（优先级更低）">↓</button>
           <button class="btn sm g" data-act="pin" data-id="${p.id}" title="取消置顶">取消置顶</button>`
        : (p.status === 'published'
          ? `<button class="btn sm" data-act="pin" data-id="${p.id}" title="置顶到文章列表最前">📌 置顶</button>`
          : '');
      const btnPub = p.status === 'published'
        ? `<button class="btn sm g" data-act="unpub" data-id="${p.id}" data-slug="${esc(p.slug)}">下线</button>`
        : `<button class="btn sm ok" data-act="pub" data-id="${p.id}">发布</button>`;
      // url 由后端按永久链接规则算好下发；老接口没有时退回 /post/:slug
      const purl = p.url || ('/post/' + p.slug);
      const viewL = p.status === 'published' ? `<a class="btn sm g" href="${esc(purl)}" target="_blank" rel="noopener">查看</a>` : '';
      return `<tr>
        <td><div class="cell-title">${esc(p.title)}${p.pinned ? '<span class="pin-mini" title="已置顶">📌</span>' : ''}${st}${lockTag}</div>
          <div class="cell-sub">${esc(purl)} ${cat ? ' · ' + cat : ''}</div></td>
        <td>${tags || '<span class="cell-sub">无标签</span>'}</td>
        <td style="white-space:nowrap">${fmtTime(p.published_at || p.updated_at)}</td>
        <td style="white-space:nowrap">${p.view_count || 0} / ${p.comment_count || 0}</td>
        <td style="white-space:nowrap"><a class="btn sm" href="#/posts/${p.id}">编辑</a>${btnPin}${btnPub}${viewL}
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
          } else if (act === 'pin' || act === 'pinup' || act === 'pindown') {
            // 后端回调整后的置顶顺序；前端不自己算优先级数字，只按 action 调接口再刷新列表
            const action = act === 'pin' ? 'toggle' : (act === 'pinup' ? 'up' : 'down');
            const r = await API.post('/pin', { id: parseInt(id, 10), action });
            if (action === 'toggle') {
              toast(r.pinned.indexOf(parseInt(id, 10)) >= 0
                ? '已置顶 ✓ 前台首页 / 分类 / 标签 / 搜索都会把它排在文章列表最前'
                : '已取消置顶');
            } else {
              toast(r.moved === false
                ? (action === 'up' ? '已经在置顶里最靠前了' : '已经在置顶里最靠后了')
                : '置顶顺序已调整 ✓');
            }
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

// ================= 写文章 / 编辑（kind: 'post' 文章 | 'page' 独立页面） =================
// 页面与文章共用同一个编辑器：页面只是**少几项**（不设分类、标签、封面），
// 多一个「在站点导航显示」开关，地址固定 /p/<别名>，且不进文章流。
async function viewEditor(id, kind = 'post') {
  const isPage = kind === 'page';
  pageTitle(id ? (isPage ? '编辑页面' : '编辑文章') : (isPage ? '新建页面' : '写文章'));
  showLoading('加载编辑器…');
  let post = null;
  const cats = isPage ? [] : (await API.get('/categories').catch(() => []));
  if (id) post = await API.get('/posts/' + id); // 单篇读取：后端路由为 GET /api/posts/:id
  // 阅读密码：明文回填显示 —— 博主自己看得见，省得每次重设都要再输一遍
  const pw = String(post?.password || '');

  shell(`
  <div class="page-head"><h1>${id ? (isPage ? '编辑页面' : '编辑文章') : (isPage ? '新建页面' : '写文章')}</h1>
    <div class="spacer"><a class="btn g" href="#/${isPage ? 'pages' : 'posts'}">← 返回${isPage ? '页面' : '文章'}列表</a></div></div>
  <div class="ed-card">
    <div class="ed-title"><input id="e-title" placeholder="在此输入${isPage ? '页面' : '文章'}标题…" value="${esc(post?.title || '')}"></div>
    <div class="ed-meta">
      ${isPage ? '' : `<span class="f2">分类
        <select id="e-cat"><option value="">（无分类）</option>
        ${catOptionsHtml(cats, post ? post.category_id : null)}
        </select></span>
      <span class="f2">标签 <input id="e-tags" placeholder="多个标签用逗号分隔" value="${esc((post?.tags || []).map((t) => t.name).join(',') || '')}"></span>`}
      <span class="f2">别名 <input id="e-slug" placeholder="留空自动生成（英文数字 -）" value="${esc(post?.slug || '')}">
        <a id="e-slug-rand" href="javascript:;" title="随机生成">🎲</a></span>
      ${isPage ? '' : `<span class="f2"><label><input type="checkbox" id="e-lock"${pw ? ' checked' : ''}> 加密</label>
        <input id="e-pass" type="text" placeholder="阅读密码" value="${esc(pw)}"${pw ? '' : ' disabled'} style="max-width:150px" autocomplete="off"></span>`}
      ${isPage ? `<span class="f2"><label><input type="checkbox" id="e-innav" ${(post ? Number(post.in_nav) : 1) ? 'checked' : ''}> 在站点导航显示</label></span>`
    : `<span class="f2">封面 <input type="file" id="e-cover" accept="image/*" style="max-width:190px">
        <span id="e-cover-prev" style="display:${post?.cover_key ? '' : 'none'}"><img src="/media/${esc(post?.cover_key || '')}" style="height:34px;border-radius:6px;vertical-align:middle">
        <a id="e-cover-del" href="javascript:;" style="margin-left:4px">移除</a></span></span>`}
      <span id="e-status" class="hint"></span>
    </div>
    ${isPage ? `<div class="hint" style="padding:0 2px 8px">页面地址：<b>/p/&lt;别名&gt;</b>（不进文章列表、归档、搜索与 RSS；可勾选在站点导航显示）</div>` : ''}
    <div id="e-host"></div>
    <div class="ed-actions">
      <button class="btn g" id="e-save-draft">保存草稿</button>
      <button class="btn p" id="e-publish">${post ? '保存并更新（保持当前状态）' : (isPage ? '一键发布页面' : '一键发布')}</button>
      <button class="btn v" id="e-preview">预览</button>
      <span class="spacer hint">提示：编辑器所见即所得，正文将保存为 Markdown；${isPage ? '页面发布后进入站点地图与导航。' : '发布后自动生成网页、分类/标签/归档页、RSS 与站点地图。'}快捷键 Ctrl+S 保存草稿。</span>
    </div>
  </div>`);

  const editorHost = view().querySelector('#e-host');
  editor = new Editor(editorHost, { ph: '开始写作…（可粘贴图片，或点工具栏 🖼 上传图片至 R2）' });
  editor.upload = async (file) => {
    const d = await API.upload(file);
    toast('图片已上传' + webpNote(d));
    return d.url;
  };
  editor.setHTML(post?.content_html || '');

  // 别名随机
  view().querySelector('#e-slug-rand').addEventListener('click', () => {
    view().querySelector('#e-slug').value = (isPage ? 'page-' : 'post-') + Date.now().toString(36);
  });

  // 封面（页面没有封面：元素不存在时整段跳过，不能直接 addEventListener 否则报错）
  let coverKey = post?.cover_key || null;
  const coverPrev = () => {
    const box = view().querySelector('#e-cover-prev');
    if (!box) return;
    box.style.display = coverKey ? '' : 'none';
    if (coverKey) box.querySelector('img').src = '/media/' + coverKey;
  };
  const coverIn = view().querySelector('#e-cover');
  if (coverIn) coverIn.addEventListener('change', async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    try {
      const d = await API.upload(file);
      coverKey = d.key;
      coverPrev();
      toast('封面已上传' + webpNote(d));
    } catch (e) { toast(e.message, 'bad'); }
  });
  const coverDel = view().querySelector('#e-cover-del');
  if (coverDel) coverDel.addEventListener('click', () => { coverKey = null; coverPrev(); });

  // 加密开关：勾上才让填密码（明文输入，只输一遍）；取消勾选立刻禁用并清空
  const lockEl = view().querySelector('#e-lock');
  const passEl = view().querySelector('#e-pass');
  if (lockEl && passEl) {
    const syncLock = () => {
      passEl.disabled = !lockEl.checked;
      if (!lockEl.checked) passEl.value = '';
      else passEl.focus();
    };
    lockEl.addEventListener('change', syncLock);
  }

  const updateStatus = (st) => {
    view().querySelector('#e-status').textContent = st === 'published' ? '当前状态：已发布' : '当前状态：草稿（仅你可见）';
    view().querySelector('#e-status').style.color = st === 'published' ? '#15803d' : '#b45309';
  };
  updateStatus(post ? post.status : 'draft');

  // 防误关（模块级 dirty + 一次性守卫）
  dirty = false;
  const markDirty = () => { dirty = true; };
  // 只给页面上真实存在的元素绑（页面编辑器没有分类 / 标签）
  ['#e-title', '#e-tags', '#e-slug', '#e-cat', '#e-innav', '#e-lock', '#e-pass'].forEach((s) => {
    const em = view().querySelector(s);
    if (em) em.addEventListener('input', markDirty);
  });
  editorHost.addEventListener('input', markDirty);
  draftSaver = () => save(false);

  const collect = () => {
    const title = view().querySelector('#e-title').value.trim();
    if (!title) throw new Error(`请填写${isPage ? '页面' : '文章'}标题`);
    const md = editor.getMarkdown();
    if (!md) throw new Error(`${isPage ? '页面' : '文章'}内容不能为空`);
    const tagEl = view().querySelector('#e-tags');   // 页面没有标签 / 分类，取不到就留空
    const catEl = view().querySelector('#e-cat');
    const navEl = view().querySelector('#e-innav');
    const lkEl = view().querySelector('#e-lock');
    const psEl = view().querySelector('#e-pass');
    const useLock = !!(lkEl && lkEl.checked);
    // 勾了加密却没填密码：直接拦下，否则会存成空密码（等于没加密）还看不出来
    if (useLock && !(psEl && psEl.value.trim())) throw new Error('勾选加密后请填写阅读密码');
    const tags = tagEl ? tagEl.value.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean) : [];
    return {
      title,
      content_md: md,
      slug: view().querySelector('#e-slug').value.trim(),
      category_id: catEl ? (catEl.value || null) : null,
      tags,
      cover_key: coverKey,
      excerpt: '',
      // 只有文章有加密开关：页面不传 password，后端就不会覆盖已有值
      ...(isPage ? {} : { password: useLock ? psEl.value.trim() : '' }),
      // type / in_nav 只有页面才提交：文章不传，后端就不会改动它
      ...(isPage ? { type: 'page', in_nav: navEl ? (navEl.checked ? 1 : 0) : 1 } : {}),
    };
  };
  // 发布成功后统一走这里：弹「发布成功」→ 回文章列表。
  // ⚠️ 以前只有「更新已有文章」走这条路，新建发布直接 go('#/posts/:id') 跳回编辑页，
  //    两条路径行为不一致：新建一篇直接点发布会停在编辑页，看着像没发出去。
  const finishPublish = async (postId, slug) => {
    // 地址按当前永久链接规则取，别再硬拼 /post/:slug
    let purl = '/post/' + slug;
    try { purl = (await API.get('/posts/' + postId)).url || purl; } catch (e) { /* 取不到就退回旧写法 */ }
    const open = await dialog({
      title: '发布成功',
      bodyHtml: `${isPage ? '页面' : '文章'}地址：<a href="${esc(purl)}" target="_blank">${esc(purl)}</a>${
        isPage ? '' : '<br>订阅：<a href="/rss.xml" target="_blank">/rss.xml</a> · <a href="/sitemap.xml" target="_blank">/sitemap.xml</a>'}`,
      actions: [{ val: 'list', label: '返回列表', cls: 'p' }, { val: 'open', label: `打开${isPage ? '页面' : '文章'}`, cls: 'g' }],
    });
    if (open === 'open') window.open(purl, '_blank');
    go(isPage ? '#/pages' : '#/posts');
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
        id = r.id;  // 记下新 id：之后在同一页继续点保存是更新，不会重复建一篇
        toast(publish
          ? (isPage ? '已发布 ✓ 页面已上线，并进入站点地图与导航' : '已发布 ✓ 前台、分类/标签页、RSS、站点地图均已同步')
          : '草稿已保存');
        if (publish) { dirty = false; await finishPublish(id, slug); return; }
        // 新建草稿：把地址换成真实 id 才能继续编辑，否则再点保存又会新建一篇
        dirty = false;
        go((isPage ? '#/pages/' : '#/posts/') + id);
        return;
      }
      dirty = false;
      if (publish) await finishPublish(id, slug);
      else updateStatus('draft');
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
        title: `${isPage ? '页面' : '文章'}预览（与发布效果一致）`,
        bodyHtml: `<iframe style="width:100%;height:66vh;border:1px solid #e3e7ef;border-radius:10px;background:#f6f7f9" sandbox="" srcdoc="${esc(r.html)}"></iframe>`,
        actions: [{ val: 'ok', label: '关闭', cls: 'p' }],
      });
    } catch (e) { toast(e.message, 'bad'); }
    pBtn.disabled = false;
  });

  editor.we.focus();
}

// ================= 独立页面列表 =================
// 与文章完全分开：页面不进文章列表 / 归档 / 搜索 / RSS，地址固定 /p/<别名>，
// 可选显示在站点导航（in_nav）。编辑复用同一个编辑器（viewEditor(kind='page')）。
async function viewPages() {
  pageTitle('页面');
  showLoading();
  shell(`<div class="page-head"><h1>独立页面</h1>
    <div class="spacer">
      <input class="inp" id="pg-q" placeholder="搜索页面标题…" style="width:190px">
      <button class="btn p" id="pg-new">＋ 新建页面</button>
    </div></div>
    <div class="tabs" id="pg-tabs">
      <button data-t="all">全部</button><button data-t="published">已发布</button><button data-t="draft">草稿</button>
    </div>
    <div class="card"><div id="pg-list"><div class="loading">加载中…</div></div></div>`);
  let page = 1;
  const qEl = view().querySelector('#pg-q');
  const tabsEl = view().querySelector('#pg-tabs');

  const syncTabs = () => {
    tabsEl.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.t === pageTab));
  };
  const loadList = async () => {
    const listEl = view().querySelector('#pg-list');
    listEl.innerHTML = '<div class="loading">加载中…</div>';
    try {
      const qs = new URLSearchParams({ status: pageTab, type: 'page', page: String(page), per: '30' });
      if (qEl.value.trim()) qs.set('q', qEl.value.trim());
      const data = await API.get('/posts?' + qs.toString());
      renderRows(listEl, data);
    } catch (e) { listEl.innerHTML = `<div class="empty-note">${esc(e.message)}</div>`; }
  };
  const renderRows = (listEl, data) => {
    if (!data.items.length) {
      listEl.innerHTML = `<div class="empty-note">${
        pageTab === 'draft' ? '暂无草稿页面' : '还没有独立页面，点右上角「新建页面」建一个（如「关于我」）。'}</div>`;
      return;
    }
    const rows = data.items.map((p) => {
      const st = p.status === 'published' ? '<span class="st published">已发布</span>' : '<span class="st draft">草稿</span>';
      const navTag = p.in_nav ? '<span class="tag-mini">导航</span>' : '';
      const purl = p.url || ('/p/' + p.slug);
      const btnPub = p.status === 'published'
        ? `<button class="btn sm g" data-act="unpub" data-id="${p.id}">下线</button>`
        : `<button class="btn sm ok" data-act="pub" data-id="${p.id}">发布</button>`;
      const viewL = p.status === 'published' ? `<a class="btn sm g" href="${esc(purl)}" target="_blank" rel="noopener">查看</a>` : '';
      return `<tr>
        <td><div class="cell-title">${esc(p.title)}${st}${navTag}</div>
          <div class="cell-sub">${esc(purl)}</div></td>
        <td style="white-space:nowrap">${fmtTime(p.updated_at || p.published_at)}</td>
        <td style="white-space:nowrap"><a class="btn sm" href="#/pages/${p.id}">编辑</a>${btnPub}${viewL}
          <button class="btn sm d" data-act="del" data-id="${p.id}" data-title="${esc(p.title)}">删除</button></td>
      </tr>`;
    }).join('');
    const pager = data.pages > 1 ? `<div class="pager-line">
      <button class="btn sm" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>‹ 上一页</button>
      <span class="hint">第 ${data.page} / ${data.pages} 页 · 共 ${data.total} 个页面</span>
      <button class="btn sm" data-page="${page + 1}" ${page >= data.pages ? 'disabled' : ''}>下一页 ›</button>
    </div>` : `<div class="hint" style="margin-top:12px">共 ${data.total} 个页面</div>`;
    listEl.innerHTML = `<div class="tbl-w"><table class="tbl"><thead><tr>
      <th>标题</th><th>最后更新</th><th>操作</th></tr></thead>
      <tbody>${rows}</tbody></table></div>${pager}`;
    listEl.querySelectorAll('button[data-act]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const act = btn.dataset.act;
        const id = btn.dataset.id;
        try {
          if (act === 'del') {
            if (!(await confirmDanger(`确定删除页面《${btn.dataset.title}》？此操作不可恢复。`, '删除页面'))) return;
            await API.del('/posts/' + id);
            toast('已删除');
          } else if (act === 'pub') {
            await API.post('/posts/' + id + '/publish', { status: 'published' });
            toast('已发布 ✓ 页面已上线，并进入站点地图');
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
    pageTab = b.dataset.t; page = 1; syncTabs(); loadList();
  });
  view().querySelector('#pg-new').addEventListener('click', () => go('#/pages/new'));
  syncTabs();
  loadList();
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
      if (/^#\/(posts|pages)\/(new|\d+)$/.test(location.hash)) {
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
        const web = /^https?:\/\/[^\s]+$/i.test(String(c.website || '').trim()) ? String(c.website).trim() : '';
        const author = (c.is_admin ? esc(c.author) + ' <span class="tag-mini">博主</span>' : esc(c.author))
          + (web ? ` <a class="hint" href="${esc(web)}" target="_blank" rel="noopener nofollow ugc">↗ 网址</a>` : '');
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

// ================= 友情链接 =================
let linkTab = 'pending';
const LINK_ST = { pending: '待审核', approved: '已展示', rejected: '已拒绝', all: '全部' };
// 编辑 / 新增共用弹窗：fields 为初始值，返回 null 表示取消
async function linkDialog(l) {
  const isNew = !l;
  const v = l || { name: '', url: '', description: '', logo: '', contact: '', reason: '', sort: 0 };
  const out = {};
  const res = await dialog({
    title: isNew ? '新增友链' : '编辑友链',
    bodyHtml: `
      <div class="field"><label>站点名称 *</label><input class="inp" id="lkf-name" maxlength="40" value="${esc(v.name)}"></div>
      <div class="field"><label>站点地址 *（需以 http:// 或 https:// 开头）</label><input class="inp" id="lkf-url" maxlength="300" placeholder="https://example.com" value="${esc(v.url)}"></div>
      <div class="field"><label>一句话简介</label><input class="inp" id="lkf-desc" maxlength="120" value="${esc(v.description || '')}"></div>
      <div class="field"><label>图标地址（选填，正方形图片）</label><input class="inp" id="lkf-logo" maxlength="300" value="${esc(v.logo || '')}"></div>
      <div class="field"><label>排序（数字越小越靠前）</label><input class="inp" id="lkf-sort" type="number" min="0" max="9999" style="width:140px" value="${v.sort || 0}"></div>
      ${isNew ? '' : `<div class="field"><label>状态</label><select class="inp" id="lkf-status">
        <option value="pending"${v.status === 'pending' ? ' selected' : ''}>待审核</option>
        <option value="approved"${v.status === 'approved' ? ' selected' : ''}>已展示</option>
        <option value="rejected"${v.status === 'rejected' ? ' selected' : ''}>已拒绝</option>
      </select></div>`}
      ${v.contact || v.reason
        ? `<div class="hint" style="margin:6px 0 0">申请人留言：${esc(v.reason || '（无）')}${v.contact ? ` · 联系方式 ${esc(v.contact)}` : ''}</div>`
        : ''}`,
    actions: [{ val: 'ok', label: '保存', cls: 'p' }, { val: 'cancel', label: '取消', cls: 'g' }],
    onSubmit: (body) => {
      const g = (id) => body.querySelector('#' + id).value.trim();
      out.name = g('lkf-name');
      out.url = g('lkf-url');
      if (!out.name) return false;
      if (!/^https?:\/\/\S+$/i.test(out.url)) return false;
      out.description = g('lkf-desc');
      out.logo = g('lkf-logo');
      out.sort = parseInt(g('lkf-sort'), 10) || 0;
      const sel = body.querySelector('#lkf-status');
      if (sel) out.status = sel.value;
      return true;
    },
  });
  return res === 'ok' ? out : null;
}

// ================= 友圈订阅（Ver 0.4 ⑫） =================
// 编辑 / 新增订阅共用弹窗：fields 为初始值，返回 null 表示取消
async function feedDialog(f) {
  const isNew = !f;
  const v = f || { name: '', url: '', site_url: '', avatar: '', description: '', sort: 0, enabled: 1 };
  const out = {};
  const res = await dialog({
    title: isNew ? '添加 RSS 订阅' : '编辑 RSS 订阅',
    bodyHtml: `
      <div class="field"><label>RSS 地址 *（需以 http:// 或 https:// 开头）</label><input class="inp" id="fdf-url" maxlength="300" placeholder="https://example.com/feed.xml" value="${esc(v.url)}"></div>
      <div class="field"><label>显示名称（留空则自动取对方站点名）</label><input class="inp" id="fdf-name" maxlength="40" value="${esc(v.name || '')}"></div>
      <div class="field"><label>站点地址（选填，点来源时跳这里）</label><input class="inp" id="fdf-site" maxlength="300" placeholder="https://example.com" value="${esc(v.site_url || '')}"></div>
      <div class="field"><label>头像地址（选填，不填用名称首字方块）</label><input class="inp" id="fdf-avatar" maxlength="300" value="${esc(v.avatar || '')}"></div>
      <div class="field"><label>备注（选填，只有后台自己看得到）</label><input class="inp" id="fdf-desc" maxlength="120" value="${esc(v.description || '')}"></div>
      <div class="field"><label>排序（数字越小越靠前）</label><input class="inp" id="fdf-sort" type="number" min="0" max="9999" style="width:140px" value="${v.sort || 0}"></div>
      <div class="field"><label class="chk-line"><input type="checkbox" id="fdf-enabled"${v.enabled ? ' checked' : ''}> 启用（取消勾选＝暂停订阅，前台不再显示它的文章）</label></div>`,
    actions: [{ val: 'ok', label: isNew ? '添加并抓取' : '保存', cls: 'p' }, { val: 'cancel', label: '取消', cls: 'g' }],
    onSubmit: (body) => {
      const g = (id) => body.querySelector('#' + id).value.trim();
      out.url = g('fdf-url');
      if (!/^https?:\/\/\S+$/i.test(out.url)) return false;   // 与服务端同口径，别等服务端来回
      out.name = g('fdf-name');
      out.site_url = g('fdf-site');
      out.avatar = g('fdf-avatar');
      out.description = g('fdf-desc');
      out.sort = parseInt(g('fdf-sort'), 10) || 0;
      out.enabled = body.querySelector('#fdf-enabled').checked ? 1 : 0;
      return true;
    },
  });
  return res === 'ok' ? out : null;
}
// 订阅状态：暂停 > 失败 > 待抓取 > 正常
function friendSt(f) {
  if (!f.enabled) return { cls: 'draft', text: '已暂停' };
  if (f.last_error) return { cls: 'pending', text: '抓取失败' };
  if (!f.last_fetch) return { cls: 'draft', text: '待抓取' };
  return { cls: 'published', text: '正常' };
}

async function viewLinks() {
  pageTitle('朋友');
  showLoading();
  shell(`<div class="page-head"><h1>朋友</h1>
    <div class="spacer">
      <a class="btn g" href="/links" target="_blank" rel="noopener">前台友链 ↗</a>
      <a class="btn g" href="/friends" target="_blank" rel="noopener">前台友圈 ↗</a>
    </div></div>

    <h2 class="sec-h">友情链接<span class="sec-sub">读者申请与互换的站点</span>
      <button class="btn p sm" id="lk-new">＋ 新增友链</button></h2>
    <div class="tabs" id="lk-tabs">
      <button data-t="pending">待审核</button><button data-t="approved">已展示</button><button data-t="rejected">已拒绝</button><button data-t="all">全部</button>
    </div>
    <div id="lk-list"><div class="loading">加载中…</div></div>

    <h2 class="sec-h">友圈 · RSS 订阅<span class="sec-sub" id="fd-sub">订阅朋友的 RSS，他们的新文章会汇总到前台友圈</span>
      <button class="btn g sm" id="fd-refresh">↻ 全部刷新</button>
      <button class="btn p sm" id="fd-new">＋ 添加订阅</button></h2>
    <div id="fd-list"><div class="loading">加载中…</div></div>`);

  const load = async () => {
    const box = view().querySelector('#lk-list');
    box.innerHTML = '<div class="loading">加载中…</div>';
    try {
      const r = await API.get('/links?status=' + linkTab);
      const cnt = r.counts || {};
      view().querySelectorAll('#lk-tabs button').forEach((b) => {
        const n = cnt[b.dataset.t];
        b.classList.toggle('on', b.dataset.t === linkTab);
        b.textContent = LINK_ST[b.dataset.t] + (n ? ` (${n})` : '');
      });
      if (!r.items.length) {
        box.innerHTML = `<div class="empty-note">${linkTab === 'pending' ? '没有待审核的友链申请 🎉' : '暂无友链'}</div>`;
        return;
      }
      box.innerHTML = r.items.map((l) => {
        const ch = (String(l.name || '').trim()[0] || '?').toUpperCase();
        const logo = l.logo
          ? `<img src="${esc(l.logo)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
          : esc(ch);
        const ops = [];
        if (l.status !== 'approved') ops.push(`<button class="btn sm ok" data-o="app" data-id="${l.id}">通过</button>`);
        if (l.status !== 'rejected') ops.push(`<button class="btn sm g" data-o="rej" data-id="${l.id}">拒绝</button>`);
        ops.push(`<button class="btn sm v" data-o="edit" data-id="${l.id}">编辑</button>`);
        ops.push(`<button class="btn sm d" data-o="del" data-id="${l.id}">删除</button>`);
        const apply = (l.contact || l.reason || l.source === 'apply')
          ? `<div class="lk-apply">${l.source === 'apply' ? '<b>读者申请</b> · ' : ''}${l.contact ? `联系方式：${esc(l.contact)} · ` : ''}${l.reason ? `留言：${esc(l.reason)}` : ''}</div>`
          : '';
        return `<div class="card lk-item">
          <div class="lk-h">
            <span class="lk-logo">${logo}</span>
            <div class="lk-t"><b>${esc(l.name)}</b>
              <span class="st ${l.status}">${LINK_ST[l.status] || l.status}</span>
              <a class="hint" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.url)} ↗</a>
              ${l.description ? `<div class="hint">${esc(l.description)}</div>` : ''}
              ${apply}
            </div>
            <span class="hint lk-time">${fmtTime(l.created_at)}</span>
          </div>
          <div class="lk-ops">${ops.join('')}</div>
        </div>`;
      }).join('');
      box.querySelectorAll('button[data-o]').forEach((b) => b.addEventListener('click', async () => {
        const id = parseInt(b.dataset.id, 10);
        const o = b.dataset.o;
        try {
          if (o === 'app') { await API.patch('/links/' + id, { status: 'approved' }); toast('已通过，前台已展示'); }
          else if (o === 'rej') { await API.patch('/links/' + id, { status: 'rejected' }); toast('已拒绝'); }
          else if (o === 'del') {
            if (!(await confirmDanger('确定删除这条友链？删除后无法恢复。', '删除友链'))) return;
            await API.del('/links/' + id);
            toast('已删除');
          } else if (o === 'edit') {
            const cur = (await API.get('/links?status=all')).items.find((x) => x.id === id);
            const d = await linkDialog(cur);
            if (!d) return;
            await API.patch('/links/' + id, d);
            toast('已保存');
          }
          load();
        } catch (e) { toast(e.message, 'bad'); }
      }));
    } catch (e) { box.innerHTML = `<div class="empty-note">${esc(e.message)}</div>`; }
  };
  view().querySelector('#lk-tabs').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-t]');
    if (!b) return;
    linkTab = b.dataset.t;
    load();
  });
  view().querySelector('#lk-new').addEventListener('click', async () => {
    try {
      const d = await linkDialog(null);
      if (!d) return;
      d.status = 'approved'; // 博主自己添加的，直接展示
      await API.post('/links', d);
      toast('已添加，前台立即可见');
      linkTab = 'approved';
      load();
    } catch (e) { toast(e.message, 'bad'); }
  });
  load();

  // ---- 友圈：RSS 订阅 ----
  const loadFeeds = async () => {
    const box = view().querySelector('#fd-list');
    box.innerHTML = '<div class="loading">加载中…</div>';
    try {
      const r = await API.get('/feeds');
      const sub = view().querySelector('#fd-sub');
      if (sub) {
        sub.textContent = r.items.length
          ? `共 ${r.items.length} 个订阅${r.last_refresh ? ` · 上次刷新 ${r.last_refresh.slice(0, 16)}` : ''}`
          : '订阅朋友的 RSS，他们的新文章会汇总到前台友圈';
      }
      if (!r.items.length) {
        box.innerHTML = '<div class="empty-note">还没有订阅。点上方「＋ 添加订阅」填朋友的 RSS 地址即可。</div>';
        return;
      }
      box.innerHTML = r.items.map((f) => {
        const st = friendSt(f);
        const ch = (String(f.name || '').trim()[0] || '?').toUpperCase();
        const ava = f.avatar
          ? `<img src="${esc(f.avatar)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
          : esc(ch);
        const meta = [
          f.post_count ? `已抓 ${f.post_count} 篇` : '还没抓到文章',
          f.latest_at ? `最新 ${String(f.latest_at).slice(0, 16)}` : '',
          f.last_fetch ? `上次刷新 ${String(f.last_fetch).slice(0, 16)}` : '从未刷新',
        ].filter(Boolean).join(' · ');
        return `<div class="card fd-item">
          <div class="fd-h">
            <span class="fd-ava">${ava}</span>
            <div class="fd-t">
              <b>${esc(f.name || '（未命名，刷新后会取对方站点名）')}</b>
              <span class="st ${st.cls}">${st.text}</span>
              <div class="hint fd-url">RSS：<a href="${esc(f.url)}" target="_blank" rel="noopener noreferrer">${esc(f.url)} ↗</a>${f.site_url ? ` · 站点：<a href="${esc(f.site_url)}" target="_blank" rel="noopener noreferrer">${esc(f.site_url)} ↗</a>` : ''}</div>
              <div class="hint">${esc(meta)}</div>
              ${f.description ? `<div class="hint">${esc(f.description)}</div>` : ''}
              ${f.last_error ? `<div class="hint fd-err">上次失败：${esc(f.last_error)}</div>` : ''}
            </div>
            <span class="hint">排序 ${f.sort || 0}</span>
          </div>
          <div class="fd-ops">
            <button class="btn sm" data-o="refresh" data-id="${f.id}">刷新</button>
            <button class="btn sm v" data-o="edit" data-id="${f.id}">编辑</button>
            <button class="btn sm g" data-o="toggle" data-id="${f.id}" data-on="${f.enabled ? 1 : 0}">${f.enabled ? '暂停' : '启用'}</button>
            <button class="btn sm d" data-o="del" data-id="${f.id}">删除</button>
          </div>
        </div>`;
      }).join('');
      box.querySelectorAll('button[data-o]').forEach((b) => b.addEventListener('click', async () => {
        const id = parseInt(b.dataset.id, 10);
        const o = b.dataset.o;
        try {
          if (o === 'refresh') {
            b.disabled = true;
            b.textContent = '抓取中…';
            const r = await API.post('/feeds/' + id + '/refresh', {});
            const one = (r.results || [])[0] || {};
            toast(one.ok ? `抓取完成，共 ${one.count || 0} 篇文章` : ('抓取失败：' + (one.error || '未知原因')), one.ok ? '' : 'bad');
          } else if (o === 'edit') {
            const cur = (await API.get('/feeds')).items.find((x) => x.id === id);
            const d = await feedDialog(cur);
            if (!d) return;
            await API.patch('/feeds/' + id, d);
            toast('已保存');
          } else if (o === 'toggle') {
            const on = b.dataset.on === '1';
            await API.patch('/feeds/' + id, { enabled: on ? 0 : 1 });
            toast(on ? '已暂停，前台不再显示它的文章' : '已启用');
          } else if (o === 'del') {
            if (!(await confirmDanger('确定删除这个订阅？它抓回来的文章会一起删掉。', '删除订阅'))) return;
            await API.del('/feeds/' + id);
            toast('已删除');
          }
          loadFeeds();
        } catch (e) {
          toast(e.message, 'bad');
          loadFeeds();
        }
      }));
    } catch (e) { box.innerHTML = `<div class="empty-note">${esc(e.message)}</div>`; }
  };
  view().querySelector('#fd-new').addEventListener('click', async () => {
    try {
      const d = await feedDialog(null);
      if (!d) return;
      const r = await API.post('/feeds', d);
      toast(r.fetched
        ? `已添加 ✓ 抓到 ${r.fetched} 篇文章，前台友圈已能看到`
        : `已添加，但抓取失败：${r.error || '未知原因'}（可在列表里点「刷新」重试）`, r.fetched ? '' : 'bad');
      loadFeeds();
    } catch (e) { toast(e.message, 'bad'); }
  });
  view().querySelector('#fd-refresh').addEventListener('click', async (ev) => {
    const b = ev.currentTarget;
    b.disabled = true;
    b.textContent = '刷新中…';
    try {
      const r = await API.post('/feeds/refresh', {});
      const list = r.results || [];
      const ok = list.filter((x) => x.ok).length;
      const bad = list.length - ok;
      toast(`刷完了：成功 ${ok} 个${bad ? `，失败 ${bad} 个（原因见列表）` : ''}`, bad ? 'bad' : '');
      loadFeeds();
    } catch (e) {
      toast(e.message, 'bad');
      loadFeeds();
    }
  });
  loadFeeds();
}

// ================= 分类（支持二级） =================
// 分类下拉：顶级分类下挂自己的二级分类，二级显示为「　└ 子名」
function catOptionsHtml(cats, selectedId) {
  const sel = selectedId == null ? '' : String(selectedId);
  const opt = (c, label) => `<option value="${c.id}"${sel === String(c.id) ? ' selected' : ''}>${esc(label)}</option>`;
  const out = [];
  for (const c of cats.filter((x) => !x.parent_id)) {
    const kids = cats.filter((x) => Number(x.parent_id) === Number(c.id));
    if (!kids.length) { out.push(opt(c, c.name)); continue; }
    out.push(`<optgroup label="${esc(c.name)}">`);
    out.push(opt(c, c.name + '（本级）'));
    for (const k of kids) out.push(opt(k, '　└ ' + k.name));
    out.push('</optgroup>');
  }
  // 上级已不存在的孤儿分类：照样列出来，避免它从界面上消失
  for (const c of cats) if (c.parent_id && !cats.some((x) => Number(x.id) === Number(c.parent_id))) out.push(opt(c, c.name));
  return out.join('');
}
// 分类访问地址：二级是 /category/父别名/子别名
const catUrlOf = (c) => '/category/' + (c.full_slug || c.slug);

async function viewCategories() {
  pageTitle('分类');
  showLoading();
  let cats = await API.get('/categories');
  shell(`
  <div class="page-head"><h1>分类</h1><div class="spacer"><a class="btn g" href="/categories" target="_blank" rel="noopener">前台查看 ↗</a></div></div>
  <div class="card">
    <div class="sec-title">新建分类 <small>支持两级：顶级分类，或挂在某个顶级分类下的二级分类</small></div>
    <form id="cat-add">
      <div class="field cat-f-name"><label>名称</label>
        <input class="inp" id="cat-new-name" placeholder="如：技术笔记" required></div>
      <div class="field cat-f-slug"><label>别名（网址用，选填）</label>
        <input class="inp" id="cat-new-slug" placeholder="如 tech-notes">
        <div class="hint cat-tip">访问地址 <b id="cat-new-prev">/category/…</b> · 别名只能用小写英文字母、数字和 -；
          中文名称请手动填一个英文别名，留空会自动生成一串随机字符，不利于收录。</div></div>
      <div class="field"><label>上级分类</label>
        <select class="inp" id="cat-new-parent"><option value="0">（作为顶级分类）</option></select>
        <div class="hint">选了上级就是二级分类，地址变成 <b>/上级别名/本级别名</b>；二级分类下面不能再建下级。</div></div>
      <div class="field" id="cat-new-nav-field"><label style="display:flex;align-items:center;gap:8px">
        <input type="checkbox" id="cat-new-nav" style="width:auto"> 在导航栏显示</label>
        <div class="hint">勾选后出现在前台页头导航；有二级分类时，鼠标移到它上面会自动展开下拉。</div></div>
      <div class="cat-add-row"><button class="btn p" type="submit">新建</button></div>
    </form>
    <div id="cat-list"></div>
  </div>`);
  const renderCats = (list) => {
    const tree = [];
    for (const c of list.filter((x) => !x.parent_id)) {
      tree.push(c);
      for (const k of list) if (Number(k.parent_id) === Number(c.id)) tree.push(k);
    }
    for (const c of list) if (!tree.includes(c)) tree.push(c);
    view().querySelector('#cat-list').innerHTML = !tree.length ? '<div class="empty-note">还没有分类</div>' :
      `<div class="tbl-w"><table class="tbl"><thead><tr><th>名称</th><th>文章数</th><th>导航</th><th>操作</th></tr></thead><tbody>${
      tree.map((c) => `<tr${c.parent_id ? ' class="row-sub"' : ''}><td>${c.parent_id ? '<span class="sub-mark">└</span>' : ''}<b>${esc(c.name)}</b>${
        c.parent_id && c.parent_name ? `<span class="cell-sub">上级：${esc(c.parent_name)}</span>` : ''}
        <div class="cell-sub"><a class="cat-slug" href="${esc(catUrlOf(c))}" target="_blank" rel="noopener" title="在前台打开">${esc(catUrlOf(c))} ↗</a>${c.description ? ' · ' + esc(c.description) : ''}</div></td>
        <td>${c.count}</td><td>${c.parent_id ? '<span class="cell-sub">随上级</span>' : (Number(c.in_nav) ? '<span class="tag-on">导航</span>' : '<span class="cell-sub">不显示</span>')}</td>
        <td><button class="btn sm" data-i="${c.id}" data-n="${esc(c.name)}" data-s="${esc(c.slug)}" data-d="${esc(c.description)}" data-p="${c.parent_id || 0}" data-v="${Number(c.in_nav) ? 1 : 0}" data-cat="1">编辑</button>
        <button class="btn sm d" data-del-cat="${c.id}" data-n="${esc(c.name)}" data-sub="${c.parent_id ? 0 : (list.filter((k) => Number(k.parent_id) === Number(c.id)).length)}">删除</button></td></tr>`).join('')}
      </tbody></table></div>`;
    // 上级下拉：只有顶级分类可选（两级封顶）
    const sel = view().querySelector('#cat-new-parent');
    if (sel) {
      const tops = list.filter((c) => !c.parent_id);
      sel.innerHTML = '<option value="0">（作为顶级分类）</option>'
        + tops.map((c) => `<option value="${c.id}">${esc(c.name)}（/${esc(c.slug)}）</option>`).join('');
    }
  };
  renderCats(cats);
  // 别名合法性：只允许小写英文/数字/-（与后端 /api/categories 的校验一致）
  const SLUG_RE = /^[a-zA-Z0-9-]+$/;
  const slugifyUi = (s) => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const newName = view().querySelector('#cat-new-name');
  const newSlug = view().querySelector('#cat-new-slug');
  const newPrev = view().querySelector('#cat-new-prev');
  const newParent = view().querySelector('#cat-new-parent');
  const newNav = view().querySelector('#cat-new-nav');
  const newNavField = view().querySelector('#cat-new-nav-field');
  const syncNewPrev = () => {
    const p = cats.find((c) => String(c.id) === String(newParent.value));
    newPrev.textContent = '/category/' + (p ? p.slug + '/' : '') + (slugifyUi(newSlug.value) || '…');
    // 二级分类不占导航位（跟着上级在下拉里出现），所以勾选框直接收起来
    newNavField.style.display = p ? 'none' : '';
  };
  // 名称是纯英文时自动带出别名，省得手打；中文则不动，等用户自己填
  newName.addEventListener('input', () => {
    if (newSlug.value) { syncNewPrev(); return; }
    const auto = slugifyUi(newName.value);
    if (auto && /^[\x00-\x7F]+$/.test(newName.value)) { newSlug.value = auto; }
    syncNewPrev();
  });
  newSlug.addEventListener('input', syncNewPrev);
  newParent.addEventListener('change', syncNewPrev);
  syncNewPrev();

  view().querySelector('#cat-add').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const name = newName.value.trim();
    if (!name) { toast('请输入分类名称', 'bad'); return; }
    const slug = newSlug.value.trim();
    if (slug && !SLUG_RE.test(slug)) { toast('别名只能用英文字母、数字和连字符 -', 'bad'); newSlug.focus(); return; }
    try {
      const r = await API.post('/categories', { name, slug, description: '',
        parent_id: parseInt(newParent.value, 10) || 0, in_nav: newNav.checked ? 1 : 0 });
      toast(r.slug && !slug && /^cat-\d+$/.test(r.slug)
        ? `分类已创建，但未填别名，系统自动生成了 ${r.slug}，建议编辑改成可读的英文别名`
        : '分类已创建');
      cats = await API.get('/categories');
      renderCats(cats);
      newName.value = ''; newSlug.value = ''; newNav.checked = false; syncNewPrev();
    } catch (e) { toast(e.message, 'bad'); }
  });
  view().querySelector('#cat-list').addEventListener('click', async (ev) => {
    const b = ev.target.closest('button[data-del-cat]');
    if (b) {
      const kid = parseInt(b.dataset.sub, 10) || 0;
      const warn = kid ? `（其下 ${kid} 个二级分类不会被删除，会自动升为顶级分类，地址会少一层）` : '';
      if (!(await confirmDanger(`删除分类「${b.dataset.n}」？其下文章将变为无分类，不会被删除。${warn}`, '删除分类'))) return;
      try {
        await API.del('/categories/' + b.dataset.delCat);
        toast('已删除');
        cats = await API.get('/categories');
        renderCats(cats);
      } catch (e) { toast(e.message, 'bad'); }
      return;
    }
    const eb = ev.target.closest('button[data-cat]');
    if (!eb) return;
    const oldSlug = eb.dataset.s || '';
    let payload = null;
    const dlgP = dialog({
      title: '编辑分类',
      bodyHtml: `<div class="field"><label>名称</label><input class="inp" id="cn" value="${eb.dataset.n}"></div>
        <div class="field cat-dlg-slug"><label>别名（网址用）</label><input class="inp" id="cs" value="${eb.dataset.s}" placeholder="如 tech-notes">
          <div class="hint" style="margin:6px 0 0">访问地址 <b id="cs-prev">/category/${esc(oldSlug)}</b></div>
        </div>
        <div class="field"><label>上级分类</label><select class="inp" id="cp">
          <option value="0"${eb.dataset.p === '0' ? ' selected' : ''}>（顶级分类）</option>
          ${cats.filter((c) => !c.parent_id && String(c.id) !== String(eb.dataset.i))
            .map((c) => `<option value="${c.id}"${String(c.id) === String(eb.dataset.p) ? ' selected' : ''}>${esc(c.name)}（/${esc(c.slug)}）</option>`).join('')}
        </select></div>
        <div class="field" id="cv-field"><label style="display:flex;align-items:center;gap:8px">
          <input type="checkbox" id="cv" style="width:auto"${eb.dataset.v === '1' ? ' checked' : ''}> 在导航栏显示</label>
          <div class="hint">二级分类不单独占导航位，鼠标移到它的上级分类上会自动展开下拉。</div></div>
        <div class="field"><label>描述</label><textarea class="txa" id="cd" style="min-height:70px">${eb.dataset.d}</textarea></div>
        <div class="hint" style="margin-bottom:0">别名只能用小写英文字母、数字和 -。
          <b>改了之后旧地址 /category/${esc(oldSlug)} 会失效</b>，已被搜索引擎收录的链接需要重新收录。</div>`,
      actions: [{ val: 'ok', label: '保存', cls: 'p' }, { val: 'cancel', label: '取消', cls: 'g' }],
      onSubmit: (body) => {
        // 值必须在这里取：dialog 关闭时会先把节点移除，关闭后再取就只剩空串
        const n = body.querySelector('#cn').value.trim();
        if (!n) { toast('请输入分类名称', 'bad'); return false; }
        const s = body.querySelector('#cs').value.trim();
        if (s && !SLUG_RE.test(s)) { toast('别名只能用英文字母、数字和连字符 -', 'bad'); return false; }
        const cvEl = body.querySelector('#cv');
        const pid = parseInt(body.querySelector('#cp').value, 10) || 0;
        payload = { name: n, slug: s, description: body.querySelector('#cd').value.trim(),
          parent_id: pid, in_nav: cvEl && !cvEl.disabled && cvEl.checked ? 1 : 0 };
        return true;
      },
    });
    // dialog 内部是同步插入 DOM 的，趁 Promise 还没 resolve 把实时预览绑上
    const maskEl = document.getElementById('modal-root');
    const dlgEl = maskEl ? maskEl.querySelector('.mask:last-of-type') : null;
    if (dlgEl) {
      const csEl = dlgEl.querySelector('#cs');
      const prevEl = dlgEl.querySelector('#cs-prev');
      const cpEl = dlgEl.querySelector('#cp');
      const cvEl = dlgEl.querySelector('#cv');
      const cvField = dlgEl.querySelector('#cv-field');
      const sync = () => {
        const p = cats.find((c) => String(c.id) === String(cpEl.value));
        prevEl.textContent = '/category/' + (p ? p.slug + '/' : '') + (slugifyUi(csEl.value) || '…');
        // 选了上级就是二级分类：导航勾选框禁用并取消勾选（后端也会强制置 0）
        if (cvEl && cvField) {
          cvField.style.display = p ? 'none' : '';
          cvEl.disabled = !!p;
          if (p) cvEl.checked = false;
        }
      };
      if (csEl && prevEl && cpEl) {
        csEl.addEventListener('input', sync);
        cpEl.addEventListener('change', sync);
        sync();
      }
    }
    const res = await dlgP;
    if (res !== 'ok' || !payload) return;
    try {
      const r = await API.put('/categories/' + eb.dataset.i, payload);
      if (r && r.slug && payload.slug && r.slug !== payload.slug) toast(`别名 ${payload.slug} 已被占用，已自动改为 ${r.slug}`, 'bad');
      else toast('已保存');
      cats = await API.get('/categories');
      renderCats(cats);
    } catch (e) { toast(e.message, 'bad'); }
  });
}

// ================= 标签 =================
async function viewTags() {
  pageTitle('标签');
  showLoading();
  let tags = await API.get('/tags');
  shell(`
  <div class="page-head"><h1>标签</h1><div class="spacer"><a class="btn g" href="/tags" target="_blank" rel="noopener">前台查看 ↗</a></div></div>
  <div class="card">
    <div class="sec-title">全部标签 <small>标签在写文章时直接填写，这里只做整理与删除</small></div>
    <div class="field"><input class="inp" id="tag-q" placeholder="搜索标签名称…"></div>
    <div id="tag-list"></div>
    <div class="hint" style="margin-bottom:0">改名请到「文章 → 编辑」里修改正文标签：改完保存，旧标签无文章引用时会自动留在这里，可手动删除。</div>
  </div>`);
  const renderTags = (list) => {
    view().querySelector('#tag-list').innerHTML = !list.length ? '<div class="empty-note">还没有标签（或没有匹配的标签）</div>' :
      `<div class="tbl-w"><table class="tbl"><thead><tr><th>名称</th><th>文章数</th><th>操作</th></tr></thead><tbody>${
      list.map((t) => `<tr><td><b>${esc(t.name)}</b><div class="cell-sub"><a class="cat-slug" href="/tag/${esc(t.slug)}" target="_blank" rel="noopener" title="在前台打开">/tag/${esc(t.slug)} ↗</a></div></td>
        <td>${t.count}</td><td><button class="btn sm d" data-del-tag="${t.id}" data-n="${esc(t.name)}">删除</button></td></tr>`).join('')}
      </tbody></table></div>`;
  };
  renderTags(tags);
  view().querySelector('#tag-q').addEventListener('input', (ev) => {
    const q = ev.target.value.trim().toLowerCase();
    renderTags(q ? tags.filter((t) => String(t.name).toLowerCase().includes(q) || String(t.slug).toLowerCase().includes(q)) : tags);
  });
  view().querySelector('#tag-list').addEventListener('click', async (ev) => {
    const b = ev.target.closest('button[data-del-tag]');
    if (!b) return;
    if (!(await confirmDanger(`删除标签「${b.dataset.n}」？文章内容不会被删除。`, '删除标签'))) return;
    try {
      await API.del('/tags/' + b.dataset.delTag);
      toast('已删除');
      tags = await API.get('/tags');
      view().querySelector('#tag-q').value = '';
      renderTags(tags);
    } catch (e) { toast(e.message, 'bad'); }
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
      const d = await API.upload(file);
      toast('上传成功' + webpNote(d));
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
        <button class="btn sm d" data-restore="${esc(it.name)}">恢复</button>
        <button class="btn sm g" data-delbk="${esc(it.name)}">删除</button></td></tr>`).join('')}
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
    // 从 R2 删除备份：只删这份备份文件，不动站点现有数据
    listBox.querySelectorAll('button[data-delbk]').forEach((b) => b.addEventListener('click', async () => {
      const name = b.dataset.delbk;
      if (!(await confirmDanger(
        `确定删除备份「${name}」？\n\n该备份文件将从 R2 存储中永久移除，无法通过本系统找回。\n当前站点的数据不会受影响。`,
        '删除备份'))) return;
      const btn = b;
      btn.disabled = true;
      try {
        await API.del('/backup/' + encodeURIComponent(name));
        toast('已删除备份 ' + name);
        load();
      } catch (e) {
        btn.disabled = false;
        toast(e.message, 'bad');
      }
    }));
  };
  const load = async () => {
    // 注意：后端路由是单数 /api/backup（不是 /backups）
    try { render((await API.get('/backup')).items); }
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
    const btn = view().querySelector('#b-dl');
    btn.disabled = true;
    try {
      // POST /api/backup 只返回 {ok,key}，数据存在 R2 里；需再按文件名 GET 取回内容
      const r = await API.post('/backup');
      const name = String(r.key || '').split('/').pop();
      if (!name) throw new Error('备份失败：未返回文件名');
      const res = await fetch('/api/backup/' + encodeURIComponent(name), { credentials: 'same-origin' });
      if (!res.ok) throw new Error('下载备份失败');
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      URL.revokeObjectURL(a.href);
      toast('已下载：' + name);
      load();
    } catch (e) { toast(e.message, 'bad'); }
    btn.disabled = false;
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
const SETTINGS_TABS = [
  { k: 'basic', name: '基本设置' },
  { k: 'post', name: '文章设置' },
  { k: 'sidebar', name: '侧边栏' },
  { k: 'comment', name: '评论设置' },
  { k: 'security', name: '安全设置' },
];

// ================= 侧边栏挂件目录（Ver 0.5 ②）=================
// ⚠️ 必须与服务端 functions/_lib/sidebar.js 的 WIDGETS 逐项一致（type / name / title /
//    on / count / text 都要对上），否则后台显示的顺序与默认值会和前台实际渲染脱节。
//    .sidebar-smoke.mjs 会比对两份目录，改一边忘改另一边会直接测挂。
const SB_CATALOG = [
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
const sbMeta = (t) => SB_CATALOG.find((x) => x.type === t) || null;
const sbNewId = () => 'c' + Math.random().toString(36).slice(2, 8);
// 与服务端 normalizeItems 同一套口径：脏数据按目录修回可用形态，绝不让设置页白屏
function sbFix(raw) {
  let arr = [];
  if (Array.isArray(raw)) arr = raw;
  else if (typeof raw === 'string' && raw.trim()) {
    try { const p = JSON.parse(raw); if (Array.isArray(p)) arr = p; } catch (e) { arr = []; }
  }
  const fallback = () => SB_CATALOG.filter((w) => w.type !== 'custom')
    .map((w) => ({ type: w.type, title: w.title, on: !!w.on, count: w.count || 0, text: '' }));
  if (!arr.length) return fallback();
  const seen = new Set();
  const out = [];
  for (const it of arr.slice(0, 40)) {
    const m = sbMeta(it && it.type);
    if (!m) continue;
    if (m.type !== 'custom') { if (seen.has(m.type)) continue; seen.add(m.type); }
    const o = {
      type: m.type,
      title: String((it && it.title) || '').slice(0, 40) || m.title,
      on: !it || it.on !== false,
      text: m.text ? String((it && it.text) || '').slice(0, 4000) : '',
    };
    if (m.count) {
      const n = parseInt(it && it.count, 10);
      o.count = Number.isFinite(n) ? Math.min(30, Math.max(1, n)) : m.count;
    }
    if (m.type === 'custom') {
      o.id = /^[A-Za-z0-9_-]{1,24}$/.test(String((it && it.id) || '')) ? String(it.id) : sbNewId();
    }
    out.push(o);
  }
  return out.length ? out : fallback();
}

async function viewSettings(tabArg) {
  const curTab = SETTINGS_TABS.some((t) => t.k === tabArg) ? tabArg : 'basic';
  pageTitle('设置');
  showLoading();
  shell(`
  <div class="page-head"><h1>站点设置</h1></div>
  <div class="tabs" id="set-tabs">
    ${SETTINGS_TABS.map((t) => `<button type="button" data-t="${t.k}">${t.name}</button>`).join('')}
  </div>
  <form id="set-form">

  <div class="set-pane" data-pane="basic">
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
        <div class="field"><label>ICP 备案号（可选，如 苏ICP备xxxxxxxx号）</label><input class="inp" name="beian" id="s-beian" placeholder="填写后显示在页脚并链接工信部官网；留空则不显示"></div>
      </div>
      <div>
        <div class="card">
          <div class="sec-title">站点图标 <small>页头 Logo 与浏览器标签图标（favicon）</small></div>
          <div class="field">
            <label>页头 Logo（建议高度 ≥ 72px 的 PNG / WebP，透明底更佳）</label>
            <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
              <span id="logo-prev" style="width:38px;height:38px;border-radius:9px;background:#2563eb;color:#fff;display:inline-flex;align-items:center;justify-content:center;font-weight:800;flex:none;overflow:hidden">云</span>
              <input class="inp" id="s-logo_image" placeholder="留空则使用默认：站点名称首字方块" style="flex:1;min-width:190px">
              <label class="btn" style="cursor:pointer;margin:0">上传<input type="file" id="logo-file" accept="image/*" hidden></label>
              <button class="btn" type="button" id="logo-clear">清除</button>
            </div>
          </div>
          <div class="field">
            <label>浏览器标签图标 Favicon（建议正方形，≥ 64×64）</label>
            <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
              <span id="fav-prev" style="width:38px;height:38px;border-radius:9px;background:#2563eb;color:#fff;display:inline-flex;align-items:center;justify-content:center;font-weight:800;flex:none;overflow:hidden">云</span>
              <input class="inp" id="s-favicon_image" placeholder="留空则自动沿用 Logo，再无则用默认首字图标" style="flex:1;min-width:190px">
              <label class="btn" style="cursor:pointer;margin:0">上传<input type="file" id="fav-file" accept="image/*" hidden></label>
              <button class="btn" type="button" id="fav-clear">清除</button>
            </div>
          </div>
          <p class="hint" style="margin-bottom:0">上传的图片存入 R2，地址会自动填入左侧输入框，<b>需点下方「保存全部设置」才生效</b>。两者都留空时，页头与标签页图标会显示默认的首字方块：底色固定为品牌蓝（不随主题色变化），方块里的字取站点名称首字（改站点名称会自动跟随）。</p>
        </div>
        <div class="card">
          <div class="sec-title">对外订阅与收录</div>
          <p class="hint" style="margin-top:0">发布文章后以下地址自动更新，无需任何操作：</p>
          <div class="field"><label>RSS 订阅</label><input class="inp" readonly value="${esc(location.origin)}/rss.xml" onfocus="this.select()"></div>
          <div class="field"><label>站点地图（提交给搜索引擎）</label><input class="inp" readonly value="${esc(location.origin)}/sitemap.xml" onfocus="this.select()"></div>
          <div class="field"><label>站点主页</label><input class="inp" readonly value="${esc(location.origin)}" onfocus="this.select()"></div>
        </div>
        <div class="card">
          <div class="sec-title">全站灰度 <small>整个站点转为黑白</small></div>
          <div class="nav-toggles">
            <label><input type="checkbox" id="s-gray_mode"> 启用全站灰度</label>
          </div>
          <p class="hint" style="margin-bottom:0">启用后前台与编辑器预览里的所有内容（含图片、代码块配色）统一变灰。
            <b>此项优先级最高：更换主题、改主题色都不会影响它</b>，取消勾选即可恢复。默认不启用。</p>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="sec-title">导航栏显示 <small>页头导航要露出哪些入口</small></div>
      <div class="nav-toggles">
        <label><input type="checkbox" id="s-nav_categories"> 分类</label>
        <label><input type="checkbox" id="s-nav_tags"> 标签</label>
        <label><input type="checkbox" id="s-nav_archive"> 归档</label>
        <label><input type="checkbox" id="s-nav_links"> 朋友</label>
        <label><input type="checkbox" id="s-nav_rss"> RSS</label>
      </div>
      <p class="hint" style="margin-bottom:0">「首页」固定显示，不提供开关。这里关掉某一项，只是不显示在导航栏，<b>页面地址依然可以访问</b>（如关闭 RSS 后 /rss.xml 照常能订阅）。
        分类作为单独入口显示，由「<a href="#/categories">分类</a>」里各分类的「在导航栏显示」控制；二级分类不单独占位，鼠标移到它的上级分类上会自动展开下拉。
        勾上「朋友」后，导航里是一个下拉，鼠标移上去会展开「友链」与「友圈」两项。</p>
    </div>
  </div>

  <div class="set-pane" data-pane="post">
    <div class="card">
      <div class="sec-title">代码高亮 <small>文章正文里的代码块配色</small></div>
      <div class="field"><label>代码高亮配色</label>
        <select class="inp" id="s-code_theme">
          <option value="github">GitHub 浅色（默认，与 WordPress / Typecho 观感一致）</option>
          <option value="github-dark">GitHub 深色</option>
          <option value="atom-one-light">Atom One Light 浅色</option>
          <option value="atom-one-dark">Atom One Dark 深色</option>
          <option value="xcode">Xcode 浅色</option>
          <option value="monokai">Monokai 深色</option>
          <option value="vs2015">Visual Studio 深色</option>
        </select>
      </div>
      <p class="hint" style="margin-bottom:0">切换配色<b>立即对所有文章生效</b>，已发布的文章无需重新编辑保存。代码块输出标准 &lt;pre&gt;&lt;code class="language-x"&gt; 结构，从 WordPress / Typecho 迁移过来的文章可直接正常显示。支持 21 种语言，在代码块开头写语言名即可（如 \`\`\`js）。</p>
    </div>

    <div class="card">
      <div class="sec-title">永久链接 <small>文章地址的格式（伪静态）</small></div>
      <div class="field"><label>链接格式</label>
        <select class="inp" id="s-pm-preset">
          <option value="/post/{slug}">/post/{slug}（默认）</option>
          <option value="/post/{slug}.html">/post/{slug}.html</option>
          <option value="/{slug}.html">/{slug}.html</option>
          <option value="/archives/{id}.html">/archives/{id}.html（Typecho 风格）</option>
          <option value="/{year}/{month}/{slug}.html">/{year}/{month}/{slug}.html</option>
          <option value="/{category}/{slug}.html">/{category}/{slug}.html</option>
          <option value="__custom">自定义…</option>
        </select>
      </div>
      <div class="field" id="pm-custom" hidden><label>自定义格式</label>
        <input class="inp" id="s-permalink" placeholder="/{category}/{slug}.html" spellcheck="false">
      </div>
      <p class="hint">示例：<b id="pm-prev">/post/hello-world</b></p>
      <p class="hint" style="margin-bottom:0">可用变量：<code>{slug}</code> 别名、<code>{id}</code> 文章 ID、<code>{year}</code> <code>{month}</code> <code>{day}</code> 发布日期、<code>{category}</code> 分类别名；必须含 <code>{slug}</code> 或 <code>{id}</code>，结尾写 <code>.html</code> 即为伪静态。改格式后<b>旧地址自动 301 跳转</b>到新地址，已收录的链接不会失效；含日期或分类的规则会随文章改发布日期 / 改分类而变化。</p>
    </div>

    <div class="card">
      <div class="sec-title">版权说明 <small>显示在文章正文下方</small></div>
      <div class="field"><label>版权说明内容</label>
        <textarea class="txa" id="s-copyright" placeholder="如：本文为原创内容，转载请注明出处与作者。"></textarea>
      </div>
      <p class="hint">可用变量：<code>{title}</code> 文章标题、<code>{url}</code> 完整地址、<code>{link}</code> 相对地址、<code>{author}</code> 作者、<code>{date}</code> 发布日期、<code>{year}</code> 年份、<code>{site}</code> 站点名、<code>{siteUrl}</code> 站点地址、<code>{category}</code> 分类名；支持换行。</p>
      <p class="hint">预览：<b id="cp-prev">（未填写，文章页不显示版权内容）</b></p>
      <p class="hint" style="margin-bottom:0">内容按<b>纯文本</b>渲染（不解析 HTML），换行直接生效，无需重新编辑文章。<b>留空则文章页不显示任何版权内容。</b></p>
    </div>
  </div>

  <div class="set-pane" data-pane="sidebar">
    <div class="card">
      <div class="sec-title">侧边栏 <small>正文旁边的一列小工具</small></div>
      <label style="display:flex;align-items:center;gap:8px"><input type="checkbox" id="s-sb_on"> <b>启用侧边栏</b>（默认关闭——关闭时就是现在的单栏博客）</label>
      <p class="hint" style="margin:8px 0 0">启用后前台每一页都会在正文旁多出一列；<b>手机等窄屏（≤ 960px）自动退回单栏</b>，侧边栏落到正文下方，不挤阅读区。位置、项目与顺序随时可改，保存后前台立即生效。</p>
    </div>

    <div id="sb-body">
      <div class="card">
        <div class="sec-title">位置 <small>侧边栏在正文的哪一侧</small></div>
        <div class="field" style="max-width:280px;margin-bottom:0"><label>显示位置</label>
          <select class="inp" id="s-sb_side">
            <option value="right">正文右侧（默认）</option>
            <option value="left">正文左侧</option>
          </select>
        </div>
      </div>

      <div class="card">
        <div class="sec-title">侧边栏项目 <small>勾选启用 · ↑↓ 调顺序 · 改标题与条数</small></div>
        <div class="sb-list" id="sb-list"></div>
        <div style="margin-top:12px"><button class="btn g" type="button" id="sb-add">＋ 添加自定义项目</button></div>
        <p class="hint" style="margin-bottom:0">
          「条数」只出现在列表类挂件上（1–30）；「内容」按 <b>Markdown</b> 写（链接、图片、列表、代码块都支持），
          <b>不解析 HTML</b>，写不坏页面。<b>自定义项目</b>可以加多个，标题与内容都由你定——想放二维码、公众号、广告位就加它。
          各项只有当站点里真有内容时才出现（例如一篇评论都没有时，「最新评论」自动不显示）。
        </p>
      </div>
    </div>
  </div>

  <div class="set-pane" data-pane="comment">
    <div class="grid2">
      <div class="card">
        <div class="sec-title">评论设置</div>
        <label style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><input type="checkbox" id="s-allow"> 允许读者发表评论</label>
        <label style="display:flex;align-items:center;gap:8px"><input type="checkbox" id="s-audit"> 评论先审后发（推荐开启，防垃圾）</label>
        <label style="display:flex;align-items:center;gap:8px;margin-top:10px"><input type="checkbox" id="s-captcha"> 评论启用算术验证码（推荐开启，防机器人批量留言）</label>
        <p class="hint" style="margin:8px 0 0">关闭后评论表单将不再显示验证码，仅在确认被误伤时再关。</p>
        <p class="hint" style="margin-bottom:0">评论内置在系统内，无需外挂 Disqus / Waline。读者邮箱为必填（用于显示头像，不会公开），后台可直接审核、回复与删除。</p>
      </div>
      <div class="card">
        <div class="sec-title">评论头像 <small>Gravatar 全球通用头像</small></div>
        <div class="field"><label>头像源</label>
          <select class="inp" id="s-gravatar_source">
            <option value="weavatar">WeAvatar 国内镜像（推荐，国内最快）</option>
            <option value="cravatar">Cravatar 国内镜像（文派）</option>
            <option value="sepcc">cdn.sep.cc</option>
            <option value="gravatar">Gravatar 官方（国内通常无法访问）</option>
            <option value="secure">Gravatar 官方 secure 源</option>
          </select>
        </div>
        <p class="hint" style="margin-bottom:0">头像按邮箱 MD5 取值，<b>邮箱原文不会出现在页面上</b>，也不随接口下发给前台。若某个源取不到头像，会自动回退显示昵称首字方块。国内访问建议用 WeAvatar 或 Cravatar 镜像。</p>
      </div>
    </div>

    <div class="card">
      <div class="sec-title">邮件通知 <small>新评论提醒博主 · 博主回复提醒留言者</small></div>
      <label style="display:flex;align-items:center;gap:8px"><input type="checkbox" id="s-mail_enabled"> <b>启用邮件通知</b>（默认关闭；用第三方邮箱的 SMTP 发送）</label>
      <p class="hint" style="margin:6px 0 0">收件人：新评论通知发到「安全设置 → 博主邮箱」；回复通知发到留言者提交评论时填的邮箱。</p>
      <div id="mail-body" style="margin-top:12px">
        <label style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><input type="checkbox" id="s-mail_on_comment"> 有新评论时，发邮件通知我</label>
        <label style="display:flex;align-items:center;gap:8px"><input type="checkbox" id="s-mail_on_reply"> 我回复评论时，发邮件通知留言者</label>

        <div style="display:flex;gap:14px;margin-top:14px">
          <div class="field" style="flex:1"><label>邮件服务商</label>
            <select class="inp" id="s-mail_provider"></select>
          </div>
          <div class="field" style="flex:1"><label>发件邮箱</label><input class="inp" id="s-mail_user" type="email" placeholder="you@163.com" autocomplete="email"></div>
        </div>

        <div class="mail-notice" id="mail-pass-tip"></div>

        <div style="display:flex;gap:14px">
          <div class="field" style="flex:1"><label>密码 / 授权码</label>
            <input class="inp" id="s-mail_pass" type="password" autocomplete="new-password" placeholder="留空表示不修改">
            <p class="hint" style="margin:6px 0 0">已保存的授权码不会回显；要清除请点下方「清除已保存的授权码」。</p>
          </div>
          <div class="field" style="flex:1"><label>发件人名称（可留空）</label><input class="inp" id="s-mail_from_name" placeholder="默认使用站点名称"></div>
        </div>

        <div style="display:flex;gap:14px">
          <div class="field" style="flex:1"><label>SMTP 服务器</label><input class="inp" id="s-mail_host" placeholder="选服务商后自动填写"></div>
          <div class="field" style="width:120px"><label>端口</label><input class="inp" id="s-mail_port" type="number" min="1" max="65535" placeholder="465">
            <p class="hint" id="mail-port-warn" style="margin:6px 0 0;color:#b91c1c;font-weight:600" hidden></p></div>
          <div class="field" style="width:170px"><label>加密方式</label>
            <select class="inp" id="s-mail_secure">
              <option value="ssl">SSL / 隐式 TLS</option>
              <option value="starttls">STARTTLS</option>
            </select>
          </div>
        </div>

        <div class="field"><label>通知邮件格式</label>
          <select class="inp" id="s-mail_template"></select>
          <p class="hint" id="mail-tpl-note" style="margin:6px 0 0"></p>
        </div>

        <div class="mail-notice danger" id="mail-saved-warn" hidden></div>

        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <button class="btn g" type="button" id="mail-test">发送测试邮件</button>
          <button class="btn g" type="button" id="mail-clear-pass">清除已保存的授权码</button>
          <span class="hint" id="mail-test-note"></span>
        </div>
        <div class="mail-notice danger" style="margin-bottom:0">
          ⛔ <b>Cloudflare 禁用 25 端口</b>：本博客跑在 Cloudflare Workers 上，<b>25 端口出站被官方封禁</b>，
          填 25 会直接保存失败、邮件一封也发不出去。请只用 <b>465（SSL/TLS）</b> 或 <b>587（STARTTLS）</b>；
          若你的邮箱服务商只提供 25，说明它不能用于本方案，请换 163 / QQ / Gmail 等支持 465 或 587 的服务商。<br>
          💡 测试邮件发到「安全设置 → 博主邮箱」，用<b>当前表单里的参数</b>（没保存也能测，改完立刻可验证）；密码留空时沿用已保存的授权码。发信是异步的，点完稍等几秒看邮箱（含垃圾箱）。
        </div>
      </div>
    </div>
  </div>

  <div class="set-pane" data-pane="security">
    <div class="card">
      <div class="sec-title">博主邮箱</div>
      <div class="field"><label>邮箱地址（选填）</label><input class="inp" name="email" id="s-email" type="email" placeholder="name@example.com" autocomplete="email"></div>
      <p class="hint" style="margin-bottom:0">只做<b>格式校验</b>，不验证邮箱是否真实存在、也不会发送验证邮件。当前版本仅保存在设置中，不会在前台公开显示；留空即清除。</p>
    </div>
    <div class="card">
      <div class="sec-title">修改登录密码</div>
      <div style="display:flex;gap:10px">
        <div class="field" style="flex:1"><label>新密码（留空则不修改，至少 6 位）</label><input class="inp" type="password" name="new_password" id="s-pw" autocomplete="new-password"></div>
        <div class="field" style="flex:1"><label>确认新密码</label><input class="inp" type="password" id="s-pw2" autocomplete="new-password"></div>
      </div>
      <p class="hint" style="margin-bottom:0">密码以 <b>PBKDF2 加盐哈希</b> 存储（10 万次迭代），系统不保存明文，遗忘只能重置数据库里的管理员记录。建议定期更换、避免与其他网站相同。</p>
    </div>
  </div>

  <div class="card"><button class="btn p" id="set-save" type="submit">保存全部设置</button>
    <span class="hint" style="margin-left:10px">五个标签页的设置会一起保存；设置即时生效，前台主题、订阅地址与页面内容将同步更新。</span></div>
  </form>`);
  const v = view();

  // ---- 标签页切换：只切显示，不销毁 DOM，未保存的输入不会丢 ----
  const tabsEl = v.querySelector('#set-tabs');
  const showTab = (k, syncUrl) => {
    v.querySelectorAll('.set-pane').forEach((p) => { p.hidden = p.dataset.pane !== k; });
    tabsEl.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.t === k));
    // 用 replaceState 而非改 location.hash：后者会触发 hashchange 重新渲染整个页面
    if (syncUrl) history.replaceState(null, '', '#/settings/' + k);
  };
  tabsEl.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-t]');
    if (b) showTab(b.dataset.t, true);
  });
  showTab(curTab, false);

  const sRaw = await fetch('/api/settings/read', { credentials: 'same-origin' });
  const s = sRaw.ok ? await sRaw.json() : {};
  const set = (id, val) => { const e = v.querySelector('#' + id); if (e && val != null) e.value = val; };
  set('s-site_title', s.site_title); set('s-site_subtitle', s.site_subtitle);
  set('s-author_name', s.author_name); set('s-seo_desc', s.seo_desc);
  set('s-accent', s.accent || '#2563eb'); set('s-per_page', s.per_page || '8');
  applyAccent(s.accent || '#2563eb');
  set('s-footer_text', s.footer_text);
  set('s-beian', s.beian);
  set('s-copyright', s.copyright);
  set('s-email', s.email);
  set('s-code_theme', s.code_theme || 'github');
  set('s-gravatar_source', s.gravatar_source || 'weavatar');
  v.querySelector('#s-allow').checked = s.allow_comments !== '0';
  v.querySelector('#s-audit').checked = s.comment_audit !== '0';
  v.querySelector('#s-captcha').checked = s.captcha !== '0';
  // ---- 导航栏开关：没设过（老站）默认全开，与升级前一致 ----
  for (const k of ['categories', 'tags', 'archive', 'links', 'rss']) {
    v.querySelector('#s-nav_' + k).checked = s['nav_show_' + k] !== '0';
  }
  // ---- 全站灰度：默认关，只有明确存了 '1' 才勾上 ----
  v.querySelector('#s-gray_mode').checked = s.gray_mode === '1';

  // ---- 邮件通知：服务商预设 / 授权码提醒 / 测试发送 ----
  const mpSel = v.querySelector('#s-mail_provider');
  const mtSel = v.querySelector('#s-mail_template');
  mpSel.innerHTML = MAIL_PROVIDERS.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  mtSel.innerHTML = MAIL_TEMPLATES.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  const mHost = v.querySelector('#s-mail_host');
  const mPort = v.querySelector('#s-mail_port');
  const mSec = v.querySelector('#s-mail_secure');
  const mTip = v.querySelector('#mail-pass-tip');
  const mTplNote = v.querySelector('#mail-tpl-note');
  const mOn = v.querySelector('#s-mail_enabled');
  const mBody = v.querySelector('#mail-body');
  const mPass = v.querySelector('#s-mail_pass');
  const mUser = v.querySelector('#s-mail_user');   // 测试发信要带上表单里的发件邮箱，别漏声明
  let clearPass = false;
  let mailReady = false;    // 初始回填期间不做「自定义清空」，否则会把已保存的自定义配置抹掉
  let lastPresetHost = '';  // 最近一次由预设自动填进来的 SMTP 服务器
  // ---- 端口 25 校验：Cloudflare 封禁 25 出站，打字即红字提示，保存再拦一道 ----
  const mPortWarn = v.querySelector('#mail-port-warn');
  const mSavedWarn = v.querySelector('#mail-saved-warn');
  const portBad = () => String(mPort.value || '').trim() === '25';
  // 端口不只查 25：还得是该服务商真开了的。163 没有 587、Office365 没有 465，
  // 配上去的现象就是「连上就被断开」或干等到超时，跟账号密码无关，必须在打字时就说清楚。
  const portIssue = (rawPort, secure) => {
    const raw = String(rawPort || '').trim();
    if (raw === '25') return '25 端口在 Cloudflare 上被封禁，无法保存，请改用 465 或 587';
    const n = Number(raw);
    if (!n) return '';
    const p = curProvider();
    if (!(p.ports && p.ports.length)) return '';   // 自定义服务商不限制
    if (!p.ports.map(Number).includes(n)) {
      return `${p.name}只开放 ${p.ports.join(' / ')} 端口，没有 ${n}：连上去会被服务器直接断开`;
    }
    // 465 / 994 一律按隐式 SSL 连（端口优先于选项），所以按实际模式判定
    const mode = (n === 465 || n === 994) ? 'ssl' : (secure === 'starttls' ? 'starttls' : 'ssl');
    const allowSec = (p.secures && p.secures.length) ? p.secures : ['ssl', 'starttls'];
    if (!allowSec.includes(mode)) return `${p.name}的 ${n} 端口只支持${allowSec[0] === 'ssl' ? 'SSL / 隐式 TLS' : 'STARTTLS'}`;
    return '';
  };
  const checkPort = () => {
    const bad = portBad();
    const issue = bad ? '' : portIssue(mPort.value, mSec.value);
    const msg = bad ? `⛔ ${portIssue('25', mSec.value)}` : (issue ? `⚠️ ${issue}` : '');
    mPortWarn.hidden = !msg;
    if (msg) mPortWarn.textContent = msg;
    mPort.style.borderColor = msg ? '#b91c1c' : '';
    mPort.style.background = msg ? '#fef2f2' : '';
    return bad || !!issue;
  };
  mPort.addEventListener('input', checkPort);
  // 套用服务商预设：只在「用户主动切服务商」或「第一次进来还没配过」时调用。
  // ⚠️ 回填已保存的设置时绝不能调用 —— 否则会把用户改过的端口 / 加密方式冲回预设值
  // （表现：把 465 改成 587 保存后，页面又变回 465）。
  const applyPreset = () => {
    const p = MAIL_PROVIDERS.find((x) => x.id === mpSel.value) || MAIL_PROVIDERS[MAIL_PROVIDERS.length - 1];
    if (p.host) {
      mHost.value = p.host; mPort.value = p.port; mSec.value = p.secure;
      lastPresetHost = p.host;
    } else if (mailReady && mHost.value && mHost.value === lastPresetHost) {
      // 切到「自定义」：把上一个预设自动填的值清掉，免得把网易的服务器配给别的邮箱发出去。
      // 若 host 是用户自己手敲的（不等于任何预设值）就保留，不乱动。
      mHost.value = ''; mPort.value = ''; mSec.value = 'ssl';
    }
  };
  const curProvider = () => MAIL_PROVIDERS.find((x) => x.id === mpSel.value) || MAIL_PROVIDERS[MAIL_PROVIDERS.length - 1];
  // 该服务商开放的端口；自定义（空数组）不限制
  const allowPortsOf = (p) => ((p.ports && p.ports.length) ? p.ports.map(Number) : [465, 587]);
  // 加密方式与端口是成对的：SSL → 465，STARTTLS → 587。
  // 但只在该服务商真开了这个端口时才用；比如网易系没有 587、Office365 没有 465，
  // 硬套一个不支持的组合就是「连不上还查不出原因」。
  const syncPortBySecure = () => {
    const allow = allowPortsOf(curProvider());
    const cur = Number(String(mPort.value || '').trim());
    const want = mSec.value === 'starttls' ? 587 : 465;
    const other = mSec.value === 'starttls' ? 465 : 587;
    // 端口留空、仍是另一套的默认值、或压根不在该服务商开放列表里 —— 这三种才改
    if (!(cur === 0 || cur === other || !allow.includes(cur))) { checkPort(); return; }
    mPort.value = String(allow.includes(want) ? want : allow[0]);
    checkPort();
  };
  // 加密方式按服务商实际支持情况禁用：163 系列只能 SSL、Office365 只能 STARTTLS
  const syncSecureOptions = () => {
    const p = curProvider();
    const allow = (p.secures && p.secures.length) ? p.secures : ['ssl', 'starttls'];
    mSec.querySelectorAll('option').forEach((o) => { o.disabled = !allow.includes(o.value); });
    if (!allow.includes(mSec.value)) { mSec.value = allow[0]; syncPortBySecure(); }
  };
  // 端口 / 加密方式说明：并进授权码提示里，不单独占一行 —— 挂在端口框下方会把整行撑高、挤坏表单布局。
  // 只从 ports / secures 生成，避免和预设表里的 how 各写一份改漏。
  const portsText = (p) => {
    if (!(p.ports && p.ports.length)) return '端口按服务商要求填，常见 465（SSL）或 587（STARTTLS）';
    const list = p.ports.join(' / ');
    if (p.secures.length > 1) return `可用端口 ${list}：465 配 SSL，587 配 STARTTLS`;
    return p.secures[0] === 'ssl'
      ? `只开放端口 ${list}（SSL / 隐式 TLS；没有 587，选 STARTTLS 连不上）`
      : `只开放端口 ${list}（STARTTLS；没有 465，选 SSL 连不上）`;
  };
  const syncMail = () => {
    const p = curProvider();
    mHost.placeholder = p.host ? '选服务商后自动填写' : '如 smtp.example.com';
    // 163 / QQ / Gmail 等必须填授权码：这是配不通的第一大原因，红字写在密码框上方
    const needCode = MAIL_AUTH_CODE.includes(p.id);
    mTip.innerHTML = `⚠️ <b>${esc(p.name)}</b>：${needCode
      ? '密码栏要填<b style="color:#b91c1c">「授权码 / 专用密码」</b>，<b style="color:#b91c1c">不是邮箱登录密码</b>。' : ''}${esc(p.how)}。<br>🔌 ${esc(portsText(p))}`;
    mTplNote.textContent = (MAIL_TEMPLATES.find((x) => x.id === mtSel.value) || {}).desc || '';
    const on = mOn.checked;
    mBody.style.opacity = on ? '1' : '.55';
    mBody.querySelectorAll('input,select,button').forEach((e) => { e.disabled = !on; });
    checkPort();
  };
  // 库里已保存的端口 / 加密方式可能是不久前存进去的无效组合（比如 163 + 587）：
  // 页面会自动把表单改成推荐值，但库里的值不会自己变，必须提示用户去保存，否则看着对、实际发不出。
  const savedIssue = () => {
    const p = curProvider();
    if (!(p.ports && p.ports.length)) return '';
    const n = Number(s.mail_port || 465);
    if (p.ports.map(Number).includes(n)) return '';
    return `${p.name}只开放 ${p.ports.join(' / ')} 端口，但库里已保存的是 ${n}`;
  };
  const showSavedWarn = () => {
    const msg = savedIssue();
    mSavedWarn.hidden = !msg;
    if (!msg) { mSavedWarn.innerHTML = ''; return; }
    const p = curProvider();
    mSavedWarn.innerHTML = `⚠️ <b>已保存的配置发不出邮件</b>：${esc(msg)}。表单已自动改成推荐值 `
      + `${esc(String(p.port))}（${p.secure === 'ssl' ? 'SSL' : 'STARTTLS'}），但<b>要点「保存全部设置」才会生效</b>；`
      + '也可以直接点这里 <button class="btn g" type="button" id="mail-fix-port">恢复推荐端口并保存</button>';
    const fb = mSavedWarn.querySelector('#mail-fix-port');
    if (!fb) return;
    fb.addEventListener('click', async () => {
      mPort.value = String(p.port); mSec.value = p.secure;
      syncSecureOptions(); syncMail();
      fb.disabled = true;
      try {
        await API.patch('/settings', { mail_port: mPort.value, mail_secure: mSec.value });
        toast(`已恢复为 ${p.port}（${p.secure === 'ssl' ? 'SSL' : 'STARTTLS'}）并保存`, 'ok');
        mSavedWarn.hidden = true;
      } catch (e2) { toast('保存失败：' + (e2.message || e2), 'bad'); fb.disabled = false; }
    });
  };
  mpSel.addEventListener('change', () => { applyPreset(); syncSecureOptions(); syncMail(); showSavedWarn(); });
  mSec.addEventListener('change', () => { syncPortBySecure(); syncMail(); });
  mtSel.addEventListener('change', syncMail);
  mOn.addEventListener('change', syncMail);
  set('s-mail_provider', s.mail_provider || '163');
  set('s-mail_host', s.mail_host); set('s-mail_port', s.mail_port || '465');
  set('s-mail_secure', s.mail_secure || 'ssl');
  set('s-mail_user', s.mail_user); set('s-mail_from_name', s.mail_from_name);
  set('s-mail_template', s.mail_template || 'card');
  v.querySelector('#s-mail_on_comment').checked = s.mail_on_comment !== '0';
  v.querySelector('#s-mail_on_reply').checked = s.mail_on_reply !== '0';
  mOn.checked = s.mail_enabled === '1';
  mPass.placeholder = s.mail_pass_set === '1' ? '已保存，留空表示不修改' : '';
  // 只在这一项还没配过时套用预设；已保存过 mail_host 就一律以库里的值为准，
  // 这样改成 587 / starttls 后保存再进页面，看到的就是 587 而不是被预设改回 465
  if (!s.mail_host && mpSel.value !== 'custom') applyPreset();
  syncSecureOptions();
  syncMail();
  showSavedWarn();
  mailReady = true; // 回填已完成，此后用户切「自定义」才允许清空
  v.querySelector('#mail-test').addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    const note = v.querySelector('#mail-test-note');
    // 端口 25、或该服务商没开的端口：直接拦住，别浪费一次 30 秒的等待
    if (checkPort()) {
      note.className = 'hint mail-bad';
      note.textContent = mPortWarn.textContent.replace(/^[⛔⚠️]\s*/, '') + '。请改好后再测试';
      return;
    }
    note.className = 'hint'; note.textContent = '正在发送，请稍候…'; btn.disabled = true;
    try {
      // 把当前表单值一起发过去：测的就是眼睛看到的这一套，不必先保存
      const r = await API.post('/mail/test', {
        mail_host: mHost.value.trim(), mail_port: mPort.value, mail_secure: mSec.value,
        mail_user: mUser.value.trim(), mail_pass: mPass.value,
      });
      note.className = 'hint mail-ok';
      // used = 后端实际连的 host:port + 加密方式：页面上看到的和真发的可能不一致，显示出来好核对
      note.textContent = '发送成功：已发到 ' + (r.to || '') + '（' + (r.used || '') + '），请查收（含垃圾箱）';
    } catch (e) {
      note.className = 'hint mail-bad';
      const m = e.message || '';
      // 5xx 的响应体可能被 Cloudflare 换成自己的错误页，此时拿不到后端原因，只能给排查方向
      note.textContent = (e.code >= 500 && /^请求失败/.test(m))
        ? `服务端执行出错（Cloudflare 返回 ${e.code}，没拿到具体原因）。请到 Cloudflare 控制台 → Workers & Pages → 本项目 → Functions → 日志查看，常见原因是运行环境不支持 TCP 出站或免费版 CPU 超时。`
        : m;
    }
    btn.disabled = false;
  });
  v.querySelector('#mail-clear-pass').addEventListener('click', () => {
    clearPass = true; mPass.value = ''; mPass.placeholder = '已标记清除，保存后生效';
    toast('已标记清除授权码，点「保存全部设置」后生效');
  });
  set('s-logo_image', s.logo_image); set('s-favicon_image', s.favicon_image);

  // ---- 永久链接（伪静态）：预设下拉 + 自定义输入 + 实时示例 ----
  const PM_PRESETS = ['/post/{slug}', '/post/{slug}.html', '/{slug}.html', '/archives/{id}.html',
    '/{year}/{month}/{slug}.html', '/{category}/{slug}.html'];
  const PM_VARS = ['slug', 'id', 'year', 'month', 'day', 'category'];
  const PM_SAMPLE = { slug: 'hello-world', id: '12', year: '2026', month: '09', day: '11', category: 'tech' };
  const pmSel = v.querySelector('#s-pm-preset');
  const pmCus = v.querySelector('#s-permalink');
  const pmCusWrap = v.querySelector('#pm-custom');
  const pmPrev = v.querySelector('#pm-prev');
  // 与服务端 normalizePermalink 保持一致的口径：不合法就不让提交
  const pmValid = (raw) => {
    let x = String(raw || '').trim();
    if (!x) return false;
    if (x[0] !== '/') x = '/' + x;
    x = x.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
    if (x.length > 120) return false;
    if (!/^[A-Za-z0-9\-_.~/{}]+$/.test(x)) return false;
    if (!/\{(slug|id)\}/.test(x)) return false;
    const used = [...x.matchAll(/\{([a-zA-Z]+)\}/g)].map((m) => m[1]);
    if (used.some((k) => !PM_VARS.includes(k))) return false;
    return new Set(used).size === used.length;
  };
  const pmValue = () => (pmSel.value === '__custom' ? pmCus.value.trim() : pmSel.value);
  const pmSync = () => {
    pmCusWrap.hidden = pmSel.value !== '__custom';
    const val = pmValue();
    pmPrev.textContent = pmValid(val)
      ? val.replace(/\{(slug|id|year|month|day|category)\}/g, (_, k) => PM_SAMPLE[k])
      : '（格式不合法，将无法保存）';
  };
  pmSel.addEventListener('change', pmSync);
  pmCus.addEventListener('input', pmSync);
  const curPm = String(s.permalink || '/post/{slug}');
  if (PM_PRESETS.includes(curPm)) pmSel.value = curPm;
  else {   pmSel.value = '__custom'; pmCus.value = curPm; }
  pmSync();

  // ---- 版权说明：实时预览（变量用示例值替换，与服务端 copyrightHtml 同一口径） ----
  const cpIn = v.querySelector('#s-copyright');
  const cpPrev = v.querySelector('#cp-prev');
  const CP_SAMPLE = {
    title: '示例文章标题', url: 'https://example.com/post/hello-world', link: '/post/hello-world',
    author: '云尚', date: '2026-09-11', year: '2026',
    site: '示例站点', siteUrl: 'https://example.com', category: '技术',
  };
  const cpSync = () => {
    const t = String(cpIn.value || '').trim();
    cpPrev.textContent = t
      ? t.replace(/\{(title|url|link|author|date|year|site|siteUrl|category)\}/g, (m, k) => CP_SAMPLE[k] || m)
      : '（未填写，文章页不显示版权内容）';
  };
  cpIn.addEventListener('input', cpSync);
  cpSync();

  // ---- 主题色：边选边变（只改 :root 变量，不写库；未保存刷新会回到已保存值）----
  const accentIn = v.querySelector('#s-accent');
  accentIn.addEventListener('input', () => applyAccent(accentIn.value));

  // ---- 站点图标：预览 / 上传 / 清除 ----
  const logoIn = v.querySelector('#s-logo_image');
  const favIn = v.querySelector('#s-favicon_image');
  const setIconPrev = (el, url, ch) => {
    if (!el) return;
    el.innerHTML = url ? `<img src="${esc(url)}" alt="" style="width:100%;height:100%;object-fit:contain">` : esc(ch);
  };
  const refreshIcons = () => {
    const ch = (v.querySelector('#s-site_title').value || '').trim()[0] || '云';
    setIconPrev(v.querySelector('#logo-prev'), logoIn.value.trim(), ch);
    setIconPrev(v.querySelector('#fav-prev'), favIn.value.trim() || logoIn.value.trim(), ch);
  };
  [logoIn, favIn].forEach((el) => el.addEventListener('input', refreshIcons));
  v.querySelector('#s-site_title').addEventListener('input', refreshIcons);
  const bindIconUpload = (fileSel, inputSel) => {
    const f = v.querySelector(fileSel);
    f.addEventListener('change', async () => {
      const file = f.files && f.files[0];
      if (!file) return;
      try {
        const d = await API.upload(file);
        v.querySelector(inputSel).value = d.url || ('/media/' + d.key);
        const pct = d._webp ? Math.max(0, Math.round((1 - d._webp.to / d._webp.from) * 100)) : 0;
        toast(pct ? `已上传，转 WebP 省 ${pct}%` : '已上传');
        refreshIcons();
      } catch (e) { toast(e.message, 'bad'); }
      f.value = '';
    });
  };
  bindIconUpload('#logo-file', '#s-logo_image');
  bindIconUpload('#fav-file', '#s-favicon_image');
  v.querySelector('#logo-clear').addEventListener('click', () => { logoIn.value = ''; refreshIcons(); });
  v.querySelector('#fav-clear').addEventListener('click', () => { favIn.value = ''; refreshIcons(); });
  refreshIcons();

  // ---- 侧边栏（Ver 0.5 ②）：启用开关 / 位置 / 项目列表 ----
  const sbOnEl = v.querySelector('#s-sb_on');
  const sbSideEl = v.querySelector('#s-sb_side');
  const sbBodyEl = v.querySelector('#sb-body');
  const sbListEl = v.querySelector('#sb-list');
  let sbItems = sbFix(s.sidebar_items);
  // 关掉开关时把下面两块压暗（不销毁 DOM，已填的内容不丢）
  const sbSync = () => {
    const on = sbOnEl.checked;
    sbBodyEl.style.opacity = on ? '1' : '.55';
    sbBodyEl.style.pointerEvents = on ? '' : 'none';
  };
  sbOnEl.addEventListener('change', sbSync);
  const sbRender = () => {
    sbListEl.innerHTML = sbItems.map((it, i) => {
      const m = sbMeta(it.type);
      if (!m) return '';
      return `<div class="sb-row${it.on ? ' on' : ''}" data-i="${i}">
        <div class="sb-hd">
          <label class="sb-on"><input type="checkbox"${it.on ? ' checked' : ''}> 启用</label>
          <span class="sb-kind">${esc(m.name)}</span>
          <span class="sb-act">
            <button type="button" class="btn g sb-up" title="上移"${i === 0 ? ' disabled' : ''}>↑</button>
            <button type="button" class="btn g sb-dn" title="下移"${i === sbItems.length - 1 ? ' disabled' : ''}>↓</button>
            ${m.type === 'custom' ? '<button type="button" class="btn g sb-del" title="删除这一项">删除</button>' : ''}
          </span>
        </div>
        <div class="sb-bd">
          <label class="sb-f sb-f-ti">标题<input class="inp" value="${esc(it.title)}" maxlength="40"></label>
          ${m.count ? `<label class="sb-f sb-f-n">条数<input class="inp" type="number" min="1" max="30" value="${it.count}"></label>` : ''}
          ${m.text ? `<label class="sb-f sb-f-t">内容（Markdown）<textarea class="txa">${esc(it.text)}</textarea></label>` : ''}
        </div>
      </div>`;
    }).join('');
  };
  // 事件一律委托：每次调序都会整块重绘，逐行绑监听器会漏
  sbListEl.addEventListener('click', (e) => {
    const row = e.target.closest('.sb-row');
    if (!row) return;
    const i = parseInt(row.dataset.i, 10);
    if (!Number.isInteger(i) || !sbItems[i]) return;
    if (e.target.closest('.sb-del')) { sbItems.splice(i, 1); sbRender(); return; }
    if (e.target.closest('.sb-up') && i > 0) {
      const t = sbItems[i - 1]; sbItems[i - 1] = sbItems[i]; sbItems[i] = t; sbRender(); return;
    }
    if (e.target.closest('.sb-dn') && i < sbItems.length - 1) {
      const t = sbItems[i + 1]; sbItems[i + 1] = sbItems[i]; sbItems[i] = t; sbRender();
    }
  });
  sbListEl.addEventListener('change', (e) => {
    const row = e.target.closest('.sb-row');
    if (!row || !e.target.matches('.sb-on input')) return;
    const i = parseInt(row.dataset.i, 10);
    if (!sbItems[i]) return;
    sbItems[i].on = e.target.checked;
    row.classList.toggle('on', e.target.checked);
  });
  sbListEl.addEventListener('input', (e) => {
    const row = e.target.closest('.sb-row');
    if (!row) return;
    const i = parseInt(row.dataset.i, 10);
    const it = sbItems[i];
    if (!it) return;
    const f = e.target.closest('.sb-f');
    if (!f) return;
    if (f.classList.contains('sb-f-n')) {
      const n = parseInt(e.target.value, 10);
      it.count = Number.isFinite(n) ? Math.min(30, Math.max(1, n)) : (sbMeta(it.type).count || 5);
    } else if (f.classList.contains('sb-f-t')) {
      it.text = String(e.target.value).slice(0, 4000);
    } else {
      it.title = String(e.target.value).slice(0, 40);
    }
  });
  v.querySelector('#sb-add').addEventListener('click', () => {
    const m = sbMeta('custom');
    sbItems.push({ type: 'custom', title: m.title, on: true, count: 0, text: '', id: sbNewId() });
    sbRender();
    const last = sbListEl.querySelector('.sb-row:last-child');
    if (last) last.scrollIntoView({ block: 'nearest' });
  });
  sbOnEl.checked = s.sidebar_enabled === '1';
  sbSideEl.value = s.sidebar_side === 'left' ? 'left' : 'right';
  sbRender();
  sbSync();

  v.querySelector('#set-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    // 保存按钮同时充当防重复提交的闸门：请求在跑时它一直是禁用的，
    // 表单的默认提交按钮被禁用后回车也不会再触发 submit，所以不会重复发一份。
    const saveBtn = v.querySelector('#set-save');
    if (saveBtn.disabled) return;
    const pw = v.querySelector('#s-pw').value;
    const pw2 = v.querySelector('#s-pw2').value;
    if (pw !== pw2) { toast('两次输入的新密码不一致', 'bad'); return; }
    // 后端要求 ≥6 位、不足会静默忽略，必须在前端拦住，否则会误以为改成功了
    if (pw && pw.length < 6) { toast('新密码至少 6 位', 'bad'); return; }
    const email = v.querySelector('#s-email').value.trim();
    // 邮箱只看格式（与后端 isEmail 同一套规则）；留空表示清除，不拦
    if (email && !/^[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/.test(email)) {
      toast('邮箱格式不正确（示例：name@example.com）', 'bad'); return;
    }
    const pm = pmValue();
    if (!pmValid(pm)) {
      toast('永久链接格式不合法：需以 / 开头且包含 {slug} 或 {id}', 'bad');
      return;
    }
    // 25 端口、或该服务商没开的端口（如 163 配 587）：后端也会拒，这里先拦住并说明原因
    const pi = portIssue(mPort.value, mSec.value);
    if (pi) {
      toast(pi, 'bad');
      mPort.focus();
      return;
    }
    const body = {
      permalink: pm,
      site_title: v.querySelector('#s-site_title').value,
      site_subtitle: v.querySelector('#s-site_subtitle').value,
      author_name: v.querySelector('#s-author_name').value,
      seo_desc: v.querySelector('#s-seo_desc').value,
      accent: v.querySelector('#s-accent').value,
      per_page: v.querySelector('#s-per_page').value,
      footer_text: v.querySelector('#s-footer_text').value,
      beian: v.querySelector('#s-beian').value.trim(),
      copyright: v.querySelector('#s-copyright').value,
      email,
      code_theme: v.querySelector('#s-code_theme').value,
      gravatar_source: v.querySelector('#s-gravatar_source').value,
      allow_comments: v.querySelector('#s-allow').checked,
      comment_audit: v.querySelector('#s-audit').checked,
      captcha: v.querySelector('#s-captcha').checked,
      // 导航栏开关：关掉只是不显示在导航里，页面地址照常可访问
      nav_show_categories: v.querySelector('#s-nav_categories').checked,
      nav_show_tags: v.querySelector('#s-nav_tags').checked,
      nav_show_archive: v.querySelector('#s-nav_archive').checked,
      nav_show_links: v.querySelector('#s-nav_links').checked,
      nav_show_rss: v.querySelector('#s-nav_rss').checked,
      // 全站灰度：优先级最高的显示设置，换主题也不受影响
      gray_mode: v.querySelector('#s-gray_mode').checked,
      // 侧边栏（Ver 0.5 ②）：默认关；items 交给后端再洗一遍，前端只负责收集
      sidebar_enabled: sbOnEl.checked,
      sidebar_side: sbSideEl.value,
      sidebar_items: sbItems,
      logo_image: logoIn.value.trim(),
      favicon_image: favIn.value.trim(),
      mail_enabled: v.querySelector('#s-mail_enabled').checked,
      mail_on_comment: v.querySelector('#s-mail_on_comment').checked,
      mail_on_reply: v.querySelector('#s-mail_on_reply').checked,
      mail_provider: v.querySelector('#s-mail_provider').value,
      mail_host: v.querySelector('#s-mail_host').value.trim(),
      mail_port: v.querySelector('#s-mail_port').value,
      mail_secure: v.querySelector('#s-mail_secure').value,
      mail_user: v.querySelector('#s-mail_user').value.trim(),
      mail_from_name: v.querySelector('#s-mail_from_name').value.trim(),
      mail_template: v.querySelector('#s-mail_template').value,
      mail_clear_pass: clearPass,
    };
    // 授权码只在真的填了才提交：留空 = 保持原值，避免每次保存把已存的密码清掉
    if (mPass.value) body.mail_pass = mPass.value;
    if (pw) body.new_password = pw;
    // 一点保存整页就蒙灰 + 转圈：保存本身要跑好几秒（写设置 + 清边缘缓存），
    // 不遮一下会分不清是「在跑」还是「卡住了」。释放函数放 finally，失败也一定撤掉。
    saveBtn.disabled = true;
    const done = busy('正在保存设置…', '设置即时生效，请稍候');
    try {
      await API.patch('/settings', body);
      toast('设置已保存 ✓ 前台已同步更新');
      v.querySelector('#s-pw').value = '';
      v.querySelector('#s-pw2').value = '';
    } catch (e) { toast(e.message, 'bad'); }
    finally { saveBtn.disabled = false; done(); }
  });
}

// ================= 路由 =================
async function router() {
  if (!state.authed) { viewLogin(); return; }
  const hash = location.hash.replace(/^#\/?/, '');
  const seg = hash.split('/');
  try {
    if (hash === 'login' || hash === '' || hash === 'dashboard') {
      if (!state.authed) { viewLogin(); return; }
      await viewDashboard();
      return;
    }
    if (seg[0] === 'posts' && seg.length === 1) { await viewPosts(); return; }
    if (seg[0] === 'posts' && seg[1] === 'new') { await viewEditor(null); return; }
    if (seg[0] === 'posts' && /^\d+$/.test(seg[1] || '')) { await viewEditor(parseInt(seg[1], 10)); return; }
    // 独立页面：与文章同一套编辑/发布接口，只是 type=page
    if (seg[0] === 'pages' && seg.length === 1) { await viewPages(); return; }
    if (seg[0] === 'pages' && seg[1] === 'new') { await viewEditor(null, 'page'); return; }
    if (seg[0] === 'pages' && /^\d+$/.test(seg[1] || '')) { await viewEditor(parseInt(seg[1], 10), 'page'); return; }
    if (seg[0] === 'comments') { await viewComments(); return; }
    if (seg[0] === 'links') { await viewLinks(); return; }
    if (seg[0] === 'categories') { await viewCategories(); return; }
    if (seg[0] === 'tags') { await viewTags(); return; }
    if (seg[0] === 'media') { await viewMedia(); return; }
    if (seg[0] === 'themes') { await viewThemes(); return; }
    if (seg[0] === 'backup') { await viewBackup(); return; }
    if (seg[0] === 'settings') { await viewSettings(seg[1]); return; }
    if (seg[0] === 'logout') { await logout(); return; }
    go('#/dashboard');
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
  // 后台配色跟随主题色：任一页面刷新后都重新取一次，不必先进设置页
  API.get('/settings').then((s) => applyAccent(s && s.accent)).catch(() => {});
  window.addEventListener('hashchange', router);
  await router();
}
boot();

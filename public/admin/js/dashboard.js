// ============================================================
// 后台仪表盘（后台默认首页）
// 职责：只负责「产出 HTML」与「绑定交互」；外层的 shell / 路由由 app.js 承担，
// 这样两边不用互相 import，避免出现循环依赖。
// ============================================================
import { API } from './api.js';
import { esc, toast, fmtTime, confirmDanger } from './ui.js';

// ---------- 格式化 ----------
const fmtNum = (n) => (Number(n) || 0).toLocaleString('en-US');
const fmtWords = (n) => (Number(n) >= 10000 ? (n / 10000).toFixed(1) + ' 万' : fmtNum(n));
const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
};
// 库里存的是北京时间字符串 'YYYY-MM-DD HH:MM:SS'，补上时区才能正确求差
function ago(s) {
  if (!s) return '';
  const t = Date.parse(String(s).replace(' ', 'T') + '+08:00');
  if (!t) return fmtTime(s);
  const d = Math.floor((Date.now() - t) / 1000);
  if (d < 60) return '刚刚';
  if (d < 3600) return Math.floor(d / 60) + ' 分钟前';
  if (d < 86400) return Math.floor(d / 3600) + ' 小时前';
  if (d < 86400 * 30) return Math.floor(d / 86400) + ' 天前';
  return fmtTime(s).slice(0, 10);
}
const stBadge = (s) => (s === 'pending'
  ? '<span class="st pending">待审核</span>'
  : s === 'trash' ? '<span class="st trash">回收站</span>' : '<span class="st approved">已通过</span>');

// ---------- 各区块 ----------
const statCard = (label, num, sub, tone) => `
  <div class="dstat ${tone || ''}">
    <div class="dstat-n">${num}</div>
    <div class="dstat-l">${label}</div>
    <div class="dstat-s">${sub}</div>
  </div>`;

function countsHtml(c) {
  const avgView = c.published ? Math.round((c.views || 0) / c.published) : 0;
  const avgWord = c.posts ? Math.round((c.words || 0) / c.posts) : 0;
  const pendTxt = c.pending > 0 ? `<b class="warn-txt">${c.pending} 条待审核</b>` : '无待审核';
  return `<div class="dash-stats">
    ${statCard('文章总数', fmtNum(c.posts), `已发布 ${fmtNum(c.published)} · 草稿 ${fmtNum(c.drafts)}`, 't-blue')}
    ${statCard('评论总数', fmtNum(c.comments), pendTxt, c.pending > 0 ? 't-warn' : 't-green')}
    ${statCard('网站访问量', fmtNum(c.views), `篇均阅读 ${fmtNum(avgView)} 次`, 't-violet')}
    ${statCard('博客总字数', fmtWords(c.words), `篇均 ${fmtNum(avgWord)} 字`, 't-ink')}
  </div>
  <div class="dash-mini">
    <span>分类 <b>${fmtNum(c.categories)}</b></span>
    <span>标签 <b>${fmtNum(c.tags)}</b></span>
    <span>本月新增文章 <b>${fmtNum(c.month_posts)}</b></span>
    <span>本月新增评论 <b>${fmtNum(c.month_comments)}</b></span>
    <span>草稿 <b>${fmtNum(c.drafts)}</b></span>
  </div>`;
}

const commentItem = (c) => `
  <div class="dc-item">
    <div class="dc-h">
      <b>${esc(c.author)}</b>${c.is_admin ? '<span class="tag-mini">博主</span>' : ''}${stBadge(c.status)}
      <span class="hint">${ago(c.created_at)}</span>
      <span class="dc-src">${c.post_title
        ? `评论于 <a href="/post/${esc(c.post_slug)}" target="_blank" rel="noopener">《${esc(c.post_title)}》</a>`
        : '<span class="hint">（文章已删除）</span>'}</span>
    </div>
    <div class="dc-body">${esc(clip(c.content, 96))}</div>
    ${c.status === 'pending'
      ? `<div class="dc-ops">
          <button class="btn sm ok" data-o="app" data-id="${c.id}">通过</button>
          <button class="btn sm g" data-o="trash" data-id="${c.id}">垃圾</button>
          <button class="btn sm d" data-o="del" data-id="${c.id}">删除</button>
        </div>` : ''}
  </div>`;

const postItem = (p) => `
  <div class="dp-item">
    <div class="dp-t">
      <a href="#/posts/${p.id}">${esc(p.title)}</a>
      <span class="st ${p.status === 'published' ? 'published' : 'draft'}">${p.status === 'published' ? '已发布' : '草稿'}</span>
    </div>
    <div class="hint">
      ${esc(fmtTime(p.published_at || p.updated_at))} · 阅读 ${fmtNum(p.views)} · 评论 ${fmtNum(p.comments)}
      ${p.status === 'published' ? ` · <a href="/post/${esc(p.slug)}" target="_blank" rel="noopener">查看 ↗</a>` : ''}
    </div>
  </div>`;

const topItem = (p, i) => `
  <div class="dt-item">
    <span class="dt-r${i < 3 ? ' hot' : ''}">${i + 1}</span>
    <a class="dt-t" href="/post/${esc(p.slug)}" target="_blank" rel="noopener">${esc(p.title)}</a>
    <span class="hint">${fmtNum(p.views)} 次</span>
  </div>`;

// ---------- 整页 HTML ----------
export function dashboardHtml(d, username) {
  const c = d.counts || {};
  const pend = d.pending || [];
  const pendBox = pend.length
    ? `<div class="card dash-warn">
        <div class="dash-warn-h">
          <b>有 ${pend.length} 条评论待审核${pend.length >= 5 ? '（仅显示最近 5 条）' : ''}</b>
          <a class="btn sm g" href="#/comments">去评论管理 →</a>
        </div>
        ${pend.map(commentItem).join('')}
      </div>`
    : `<div class="card dash-calm">暂无待审核评论，评论区很干净。</div>`;

  return `
  <div class="page-head">
    <h1>仪表盘</h1>
    <div class="spacer">
      <span class="hint">${username ? esc(username) + '，' : ''}欢迎回来 · 数据更新于 ${esc(fmtTime(d.generated_at))}</span>
      <a class="btn g" href="/" target="_blank" rel="noopener">查看站点 ↗</a>
      <button class="btn p" id="d-new">＋ 写文章</button>
    </div>
  </div>

  ${countsHtml(c)}
  ${pendBox}

  <div class="grid2">
    <div>
      <div class="card">
        <div class="sec-title">最近文章<small>按发布时间排序，含草稿</small></div>
        ${(d.recent_posts || []).length
          ? d.recent_posts.map(postItem).join('') + '<div class="dash-more"><a href="#/posts">查看全部文章 →</a></div>'
          : '<div class="empty-note">还没有文章，点右上角「写文章」开始创作。</div>'}
      </div>
      <div class="card">
        <div class="sec-title">热门文章 TOP 5<small>按累计阅读量</small></div>
        ${(d.top_posts || []).length
          ? (d.top_posts || []).filter((p) => p.views > 0).map(topItem).join('') || '<div class="empty-note">还没有阅读数据</div>'
          : '<div class="empty-note">还没有已发布文章</div>'}
      </div>
    </div>
    <div>
      <div class="card">
        <div class="sec-title">最新评论<small>最近 6 条，含待审核</small></div>
        ${(d.recent_comments || []).length
          ? d.recent_comments.map(commentItem).join('') + '<div class="dash-more"><a href="#/comments">去评论管理 →</a></div>'
          : '<div class="empty-note">还没有收到评论</div>'}
      </div>
      <div class="card">
        <div class="sec-title">快捷操作</div>
        <div class="dash-quick">
          <a class="btn g" href="#/posts/new">写新文章</a>
          <a class="btn g" href="#/categories">分类与标签</a>
          <a class="btn g" href="#/media">图片库</a>
          <a class="btn g" href="#/themes">主题外观</a>
          <a class="btn g" href="#/backup">备份与恢复</a>
          <a class="btn g" href="#/settings">站点设置</a>
          <a class="btn g" href="/rss.xml" target="_blank" rel="noopener">RSS 订阅 ↗</a>
          <a class="btn g" href="/sitemap.xml" target="_blank" rel="noopener">站点地图 ↗</a>
        </div>
        <div class="hint" style="margin-top:10px">提示：总字数按 Markdown 源码统计，访问量随文章页打开次数累加。</div>
      </div>
    </div>
  </div>`;
}

// ---------- 交互绑定 ----------
// reload：由 app.js 传入，操作成功后整块重绘（顺带刷新顶栏待审角标）
export function bindDashboard(root, reload) {
  const newBtn = root.querySelector('#d-new');
  if (newBtn) newBtn.addEventListener('click', () => { location.hash = '#/posts/new'; });

  root.querySelectorAll('button[data-o]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const o = btn.dataset.o;
      try {
        if (o === 'app') {
          await API.patch('/comments/' + id, { status: 'approved' });
          toast('已通过');
        } else if (o === 'trash') {
          await API.patch('/comments/' + id, { status: 'trash' });
          toast('已移入回收站');
        } else if (o === 'del') {
          if (!(await confirmDanger('彻底删除该评论？此操作不可恢复。', '删除评论'))) return;
          await API.del('/comments/' + id);
          toast('已删除');
        }
        if (reload) await reload();
      } catch (e) { toast(e.message, 'bad'); }
    });
  });
}

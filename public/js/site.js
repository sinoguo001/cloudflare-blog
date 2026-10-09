// 前台轻量脚本：访问量上报（PV/UV + 文章阅读量）、评论异步提交
(function () {
  'use strict';

  // ---- 站点 PV 上报：所有页面（首页 / 分类 / 标签 / 归档 / 搜索 / 文章）都计一次 ----
  // 用 sendBeacon：不阻塞渲染、页面关闭时也发得出去；不支持时回退 fetch。
  // 统计口径：刷新也算一次 PV；UV 由服务端按 blog_vid Cookie 当天去重。
  (function hit() {
    var body = JSON.stringify({ p: location.pathname || '/' });
    try {
      if (navigator.sendBeacon) {
        if (navigator.sendBeacon('/api/hit', new Blob([body], { type: 'application/json' }))) return;
      }
    } catch (e) { /* 落到下面的 fetch */ }
    fetch('/api/hit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body,
      keepalive: true,
    }).catch(function () {});
  })();

  // ---- 文章阅读量：只在文章详情页累加（用于热门文章排序） ----
  var slug = document.body && document.body.dataset.slug;
  if (slug) {
    fetch('/api/view', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: slug }),
    }).catch(function () {});
  }

  // ---- 夜间模式切换（Ver 0.4 ⑧）----
  // 首帧的属性由 <head> 里的内联脚本定好（跟随系统偏好或上次的手动选择），
  // 这里只负责点击后切换并存进 localStorage；下次访问仍按存的来。
  (function dayNight() {
    var tb = document.getElementById('theme-toggle');
    if (!tb) return;
    function cur() {
      return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    }
    tb.addEventListener('click', function () {
      var next = cur() === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('blog_theme', next); } catch (e) { /* 隐私模式下写不了，本次仍生效 */ }
      tb.setAttribute('aria-pressed', next === 'dark' ? 'true' : 'false');
    });
  })();

  // ---- 导航栏搜索：点图标在顶栏下方展开搜索栏（Ver 0.4 补充）----
  // 面板一直存在于 DOM 里（CSS 里 display:none），所以脚本没跑起来时点图标仍会跳 /search 页。
  (function navSearch() {
    var btn = document.getElementById('search-toggle');
    var bar = document.getElementById('search-bar');
    if (!btn || !bar) return;
    var inp = bar.querySelector('input[name="q"]');
    function setOpen(on) {
      bar.classList[on ? 'add' : 'remove']('open');
      btn.classList[on ? 'add' : 'remove']('on');   // 放大镜变「×」
      btn.setAttribute('aria-expanded', on ? 'true' : 'false');
    }
    function isOpen() { return bar.classList.contains('open'); }
    btn.addEventListener('click', function () {
      setOpen(!isOpen());
      if (isOpen() && inp) { try { inp.focus(); inp.select(); } catch (err) { /* 老浏览器 */ } }
    });
    document.addEventListener('keydown', function (e) {
      if ((e.key === 'Escape' || e.key === 'Esc') && isOpen()) { setOpen(false); btn.focus(); }
    });
    // 点页面别处收起；点在搜索栏或图标上不算
    document.addEventListener('click', function (e) {
      if (!isOpen() || bar.contains(e.target) || btn.contains(e.target)) return;
      setOpen(false);
    });
  })();

  // ---- 文章点赞（Ver 0.4 ⑦；Ver 0.5 ① 起「我赞过没」改由这里补）----
  // 文章页 HTML 现在要进边缘缓存（对所有人同一份），所以服务端不能再按访客 Cookie
  // 回填点赞状态 —— 改成打开页面后补一次只读请求；用户已经点过就不覆盖他的操作。
  (function likes() {
    var btn = document.querySelector('.like-btn[data-like]');
    if (!btn) return;
    var id = parseInt(btn.dataset.like, 10);
    var num = btn.querySelector('.like-n');
    var tip = document.querySelector('.like-tip');
    var busy = false, touched = false;

    function paint(d) {
      if (typeof d.likes === 'number' && num) num.textContent = d.likes;
      if (typeof d.liked === 'boolean') {
        btn.classList.toggle('on', d.liked);
        btn.setAttribute('aria-pressed', d.liked ? 'true' : 'false');
        if (tip) tip.textContent = d.liked ? '已赞，再点一次取消' : '觉得有用就点个赞';
      }
    }

    btn.addEventListener('click', function () {
      if (busy) return;
      busy = true;
      touched = true;
      btn.disabled = true;
      fetch('/api/like', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: id }),
      })
        .then(function (r) { return r.json().catch(function () { return {}; }); })
        .then(function (d) {
          busy = false;
          btn.disabled = false;
          if (typeof d.likes !== 'number') return;           // 出错就保持原样，不乱改数字
          paint(d);
        })
        .catch(function () { busy = false; btn.disabled = false; });
    });

    // 补一次「我赞过没」。失败就算了：按钮停在未赞态，用户点一下也能纠正回来。
    fetch('/api/like?id=' + encodeURIComponent(id))
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (d) { if (!touched && !busy) paint(d); })
      .catch(function () {});
  })();

  // ---- 友链申请表单（/links 页）----
  var lkForm = document.getElementById('lk-form');
  if (lkForm) {
    var lkBtn = document.getElementById('lk-submit');
    var lkMsg = document.getElementById('lk-msg');
    var lkCap = document.getElementById('lk-capimg');
    function lkRefreshCap() {
      if (lkCap) lkCap.src = '/api/captcha?t=' + Date.now();
    }
    // kind: ok=绿 bad=红 空=中性灰
    function lkSay(text, kind) {
      lkMsg.textContent = text;
      lkMsg.className = 'lf-msg' + (kind ? ' ' + kind : '');
    }
    if (lkCap) lkCap.addEventListener('click', lkRefreshCap);
    lkForm.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var name = (lkForm.name.value || '').trim();
      var url = (lkForm.url.value || '').trim();
      if (!name) { lkSay('请填写站点名称', 'bad'); return; }
      if (!url) { lkSay('请填写站点地址', 'bad'); return; }
      // 服务端还会再校验一次，这里只是提前给提示，避免白跑一趟
      if (!/^https?:\/\/\S+$/i.test(url)) { lkSay('网址需以 http:// 或 https:// 开头', 'bad'); return; }
      var captcha = lkForm.captcha ? (lkForm.captcha.value || '').trim() : '';
      if (lkForm.captcha && !captcha) { lkSay('请填写图片算式的答案', 'bad'); return; }
      lkBtn.disabled = true;
      lkSay('提交中…', '');
      fetch('/api/link-apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: name, url: url,
          description: (lkForm.description.value || '').trim(),
          logo: (lkForm.logo.value || '').trim(),
          contact: (lkForm.contact.value || '').trim(),
          reason: (lkForm.reason.value || '').trim(),
          captcha: captcha,
          company: (lkForm.company && lkForm.company.value) || '',
        }),
      })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { r: r, d: d }; }); })
        .then(function (x) {
          lkBtn.disabled = false;
          lkRefreshCap();
          if (!x.r.ok) { lkSay(x.d.error || '提交失败，请稍后再试', 'bad'); lkRefreshCap(); return; }
          lkForm.reset();
          lkSay('提交成功，等待站长审核，通过后会出现在上方列表。', 'ok');
        })
        .catch(function () { lkBtn.disabled = false; lkSay('网络错误，请稍后再试', 'bad'); });
    });
    return;
  }

  var form = document.getElementById('cform');
  if (!form) return;
  // 验证码：点击图片换一张（加时间戳防缓存）
  var capImg = document.getElementById('capimg');
  function refreshCap() {
    if (capImg) capImg.src = '/api/captcha?t=' + Date.now();
  }
  if (capImg) {
    capImg.addEventListener('click', refreshCap);
    capImg.addEventListener('error', function () { capImg.title = '加载失败，点击重试'; });
  }

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var btn = form.querySelector('button[type=submit]');
    var okEl = document.getElementById('cmsg-ok');
    var badEl = document.getElementById('cmsg-bad');
    function showBad(msg) {
      badEl.textContent = msg;
      badEl.style.display = 'block';
      if (okEl) okEl.style.display = 'none';
    }
    badEl.style.display = 'none';
    if (okEl) okEl.style.display = 'none';
    btn.disabled = true;
    var body = { slug: form.dataset.post };
    body.author = (form.author.value || '').trim();
    body.email = (form.email.value || '').trim();
    body.website = (form.website && form.website.value || '').trim();
    body.content = (form.content.value || '').trim();
    // 算术验证码：题面在图片里，答案存在 HttpOnly Cookie（前端读不到，只负责回传输入值）
    body.captcha = (form.captcha && form.captcha.value || '').trim();
    body.company = (form.company && form.company.value) || '';
    if (!body.author) { btn.disabled = false; return showBad('请填写昵称'); }
    // 邮箱必填：用于生成 Gravatar 头像（只取 MD5，不公开原文）
    if (!body.email) { btn.disabled = false; return showBad('请填写邮箱，用于显示头像（不会公开）'); }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) { btn.disabled = false; return showBad('邮箱格式不正确'); }
    if (body.content.length < 3) { btn.disabled = false; return showBad('内容至少 3 个字'); }
    if (form.captcha && !body.captcha) { btn.disabled = false; return showBad('请填写图片算式的答案'); }
    fetch('/api/comments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { r: r, d: d }; }); })
      .then(function (x) {
        btn.disabled = false;
        // 验证码一次性：成功（服务端已作废旧 Cookie）或答错都换一道新题
        refreshCap();
        if (!x.r.ok) return showBad(x.d.error || '提交失败，请稍后再试');
        form.reset();
        if (okEl) {
          okEl.style.display = 'block';
          okEl.textContent = x.d.pending ? '提交成功，审核通过后将在这里显示。' : '提交成功，感谢评论！';
        }
        if (!x.d.pending) setTimeout(function () { location.reload(); }, 1200);
      })
      .catch(function () { btn.disabled = false; showBad('网络错误，请稍后再试'); });
  });
})();

// ---------- 文章目录：滚动时点亮「当前读到哪一章」（Ver 0.5 ⑧）----------
// 目录本身是服务端渲染好的，这里只负责加/摘 .on 那一个类；
// 脚本没跑起来（禁用 JS、加载失败）目录照样能点、照样能跳，只是不高亮。
(function () {
  var toc = document.getElementById('art-toc');
  if (!toc) return;
  var links = toc.querySelectorAll('a[data-toc]');
  if (!links.length) return;
  var pairs = [], i;
  for (i = 0; i < links.length; i++) {
    var h = document.getElementById(links[i].getAttribute('data-toc'));
    if (h) pairs.push({ h: h, a: links[i] });
  }
  if (!pairs.length) return;
  var box = toc.querySelector('.toc-list');
  // 判定线：标题顶端越过视口往下 96px 就算「正在读这一章」
  var OFFSET = 96;
  var cur;
  function paint(act) {
    if (act === cur) return;
    cur = act;
    for (var j = 0; j < pairs.length; j++) {
      if (pairs[j].a === act) pairs[j].a.classList.add('on');
      else pairs[j].a.classList.remove('on');
    }
    // 目录本身能滚动时（宽屏悬浮形态高度有限），把点亮那条拉进可视范围。
    // 这里手动改 scrollTop，不用 scrollIntoView —— 后者会顺带把整个页面也滚一下。
    if (act && box && box.scrollHeight > box.clientHeight + 4) {
      var r = act.getBoundingClientRect(), br = box.getBoundingClientRect();
      if (r.top < br.top + 4) box.scrollTop += r.top - br.top - 8;
      else if (r.bottom > br.bottom - 4) box.scrollTop += r.bottom - br.bottom + 8;
    }
  }
  function sync() {
    var act = null, j;
    for (j = 0; j < pairs.length; j++) {
      // 标题在正文里是按顺序出现的，遇到第一个还在判定线下方的就可以停了
      if (pairs[j].h.getBoundingClientRect().top - OFFSET <= 0) act = pairs[j].a;
      else break;
    }
    // 已经滚到底：末章可能很短，标题永远越不过判定线，这时直接点亮最后一条
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) {
      act = pairs[pairs.length - 1].a;
    }
    paint(act);
  }
  var ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(function () { ticking = false; sync(); });
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  sync();
})();
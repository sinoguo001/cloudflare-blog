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
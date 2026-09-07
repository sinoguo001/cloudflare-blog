// 前台轻量脚本：阅读量 +1、评论异步提交
(function () {
  'use strict';
  var slug = document.body && document.body.dataset.slug;
  if (slug) {
    fetch('/api/view', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: slug }),
    }).catch(function () {});
  }
  var form = document.getElementById('cform');
  if (form) {
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
      body.content = (form.content.value || '').trim();
      body.company = (form.company && form.company.value) || '';
      if (!body.author) { btn.disabled = false; return showBad('请填写昵称'); }
      if (body.content.length < 3) { btn.disabled = false; return showBad('内容至少 3 个字'); }
      fetch('/api/comments', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { r: r, d: d }; }); })
        .then(function (x) {
          btn.disabled = false;
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
  }
})();

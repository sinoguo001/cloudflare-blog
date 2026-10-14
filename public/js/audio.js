// 右下角悬浮音频播放器（Ver 0.6 ③）
// ------------------------------------------------------------
// 只在后台启用且填了地址时才会被请求（布局层条件输出这个 <script>），
// 所以这里除了「DOM 在不在」不用再判断别的；不在就安静退出。
// 全程不自动播放：浏览器会拦，也容易吓到人。
(function () {
  'use strict';

  var root = document.getElementById('au');
  if (!root) return;
  var btn = document.getElementById('au-btn');
  var closeBtn = document.getElementById('au-x');
  var audio = document.getElementById('au-a');
  var nowEl = document.getElementById('au-t');
  var liveEl = document.getElementById('au-live');
  var rng = document.getElementById('au-rng');
  var timeEl = document.getElementById('au-time');
  var playBtn = document.getElementById('au-play');
  var prevBtn = document.getElementById('au-prev');
  var nextBtn = document.getElementById('au-next');
  var listEl = document.getElementById('au-list');
  if (!btn || !audio || !listEl) return;

  // 列表直接从服务端渲染好的 DOM 上收：后台填的就是这些，不必再发请求。
  var nodes = listEl.querySelectorAll('.au-p');
  var items = [];
  var i, j;
  for (i = 0; i < nodes.length; i++) {
    items.push({
      t: nodes[i].getAttribute('data-t') || '',
      u: nodes[i].getAttribute('data-u') || '',
      el: nodes[i],
    });
  }
  if (!items.length) return;

  var cur = -1;        // 当前第几条；-1 = 还没选过
  var hls = null;      // hls.js 实例（只有 .m3u8 且浏览器不支持原生时才建）
  var hlsP = null;     // 解析库的加载 promise，多处触发时共用一次请求
  var HLS_SRC = '/js/hls.light.min.js?v=1';

  // 扩展名判断，忽略 ?query 与 #hash
  function isHls(u) {
    return /\.m3u8$/i.test(String(u).split('#')[0].split('?')[0]);
  }
  // Safari / iOS 原生就能放 HLS，这些设备不必下载解析库
  function nativeHls() {
    try { return audio.canPlayType('application/vnd.apple.mpegurl') !== ''; } catch (e) { return false; }
  }
  function fmt(s) {
    if (!isFinite(s) || s < 0) return '0:00';
    s = Math.floor(s);
    var m = Math.floor(s / 60);
    var x = s % 60;
    return m + ':' + (x < 10 ? '0' : '') + x;
  }

  // 把「播没在播」同步到界面：按钮图标、悬浮球呼吸、播放键的 aria。
  // ⚠️ 判据只能用 paused / ended，不能带 currentTime > 0 —— play 事件触发时
  //    currentTime 还是 0，第一次就被判成「没在播」；而除了 play/pause 再没有
  //    别处会调 paint()，于是声音响着、按钮却停在「播放」上（真浏览器实测抓到的）。
  function paint() {
    var on = !audio.paused && !audio.ended;
    root.classList[on ? 'add' : 'remove']('playing');
    playBtn.classList[on ? 'add' : 'remove']('on');
    playBtn.setAttribute('aria-label', on ? '暂停' : '播放');
  }

  function onTime() {
    var d = audio.duration;
    if (isFinite(d) && d > 0) {
      var p = Math.max(0, Math.min(1, audio.currentTime / d));
      rng.disabled = false;
      rng.value = Math.round(p * 1000);
      // 已播部分着色：range 自己没有「进度」伪元素，用渐变背景顶上
      rng.style.background = 'linear-gradient(to right,var(--accent) ' + (p * 100) + '%,var(--line) ' +
        (p * 100) + '%)';
      timeEl.textContent = fmt(audio.currentTime) + ' / ' + fmt(d);
    } else {
      // 直播流没有总时长（duration = Infinity），进度条没有意义
      rng.disabled = true;
      rng.value = 0;
      timeEl.textContent = isHls(items[cur] ? items[cur].u : '') ? '直播' : '0:00 / 0:00';
    }
  }

  function loadHls() {
    if (window.Hls) return Promise.resolve(window.Hls);
    if (hlsP) return hlsP;
    var p = new Promise(function (res, rej) {
      var sc = document.createElement('script');
      sc.src = HLS_SRC;
      sc.onload = function () { if (window.Hls) res(window.Hls); else rej(new Error('no Hls')); };
      sc.onerror = function () { rej(new Error('hls load failed')); };
      document.head.appendChild(sc);
    });
    p.catch(function () { hlsP = null; });   // 加载失败后允许再试
    hlsP = p;
    return p;
  }

  // 清场：停播、拆掉 hls 实例、把 src 抹掉（否则换源后旧流还在后台拉数据）
  function reset() {
    try { audio.pause(); } catch (e) { /* 无所谓 */ }
    if (hls) { try { hls.destroy(); } catch (e) { /* 无所谓 */ } hls = null; }
    try { audio.removeAttribute('src'); audio.load(); } catch (e) { /* 无所谓 */ }
  }

  function tryPlay() {
    var p;
    try { p = audio.play(); } catch (e) { return; }
    // 被浏览器拦下（自动播放策略）就停在暂停态，UI 不装作在播
    if (p && p.catch) p.catch(function () { paint(); });
  }

  function start(idx, autoplay) {
    if (idx < 0 || idx >= items.length) return;
    cur = idx;
    var it = items[idx];
    for (var k = 0; k < items.length; k++) items[k].el.classList[k === idx ? 'add' : 'remove']('on');
    nowEl.textContent = it.t;
    liveEl.hidden = !isHls(it.u);
    reset();

    if (!isHls(it.u) || nativeHls()) {
      audio.src = it.u;
      if (autoplay) tryPlay();
      return;
    }
    loadHls().then(function (Hls) {
      if (!Hls || !Hls.isSupported()) { audio.src = it.u; if (autoplay) tryPlay(); return; }
      hls = new Hls({ enableWorker: true });
      hls.on(Hls.Events.ERROR, function (ev, data) {
        if (data && data.fatal) nowEl.textContent = it.t + '（播放失败）';
      });
      hls.loadSource(it.u);
      hls.attachMedia(audio);
      if (autoplay) hls.on(Hls.Events.MANIFEST_PARSED, tryPlay);
    }).catch(function () {
      // 解析库取不到（断网 / 被拦）就退回原生，能放就放
      audio.src = it.u;
      if (autoplay) tryPlay();
    });
  }

  function next() {
    if (!items.length) return;
    start((cur + 1) % items.length, true);
  }
  function prev() {
    if (!items.length) return;
    // 播过 3 秒先回到本条开头（跟主流播放器一个习惯）；直播流不能 seek，直接换上一条
    if (cur >= 0 && isFinite(audio.duration) && audio.currentTime > 3) {
      try { audio.currentTime = 0; } catch (e) { /* 无所谓 */ }
      return;
    }
    start((cur - 1 + items.length) % items.length, true);
  }

  // ---- 面板开合 ----
  function setOpen(on) {
    root.classList[on ? 'add' : 'remove']('open');
    btn.setAttribute('aria-expanded', on ? 'true' : 'false');
  }
  btn.addEventListener('click', function () { setOpen(!root.classList.contains('open')); });
  if (closeBtn) closeBtn.addEventListener('click', function () { setOpen(false); btn.focus(); });
  // 点面板以外的地方、按 Esc 都收起（与页头搜索栏一个习惯）
  document.addEventListener('click', function (e) {
    if (root.classList.contains('open') && !root.contains(e.target)) setOpen(false);
  });
  document.addEventListener('keydown', function (e) {
    if ((e.key === 'Escape' || e.key === 'Esc') && root.classList.contains('open')) {
      setOpen(false);
      btn.focus();
    }
  });

  // ---- 播放器按钮 ----
  playBtn.addEventListener('click', function () {
    if (cur < 0) { start(0, true); return; }      // 还没选过：从第一条开始
    if (audio.paused) tryPlay();
    else audio.pause();
  });
  prevBtn.addEventListener('click', prev);
  nextBtn.addEventListener('click', next);

  // 进度条：拖动/点击都换算成秒数（直播流上这条被 disabled 挡住）
  rng.addEventListener('input', function () {
    var d = audio.duration;
    if (isFinite(d) && d > 0) audio.currentTime = (rng.value / 1000) * d;
  });

  for (j = 0; j < items.length; j++) {
    (function (idx) {
      items[idx].el.addEventListener('click', function () { start(idx, true); });
    })(j);
  }

  // ---- 播放器事件 ----
  audio.addEventListener('play', paint);
  audio.addEventListener('pause', paint);
  audio.addEventListener('timeupdate', onTime);
  audio.addEventListener('loadedmetadata', onTime);
  audio.addEventListener('durationchange', onTime);
  audio.addEventListener('ended', next);          // 播完自动下一首，列表循环
  audio.addEventListener('error', function () {
    if (!hls && cur >= 0) nowEl.textContent = items[cur].t + '（加载失败）';
  });
})();

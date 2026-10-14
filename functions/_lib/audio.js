// ============================================================
// 音频播放（Ver 0.6 ③）
// ------------------------------------------------------------
// 只播「流媒体地址」：后台逐条填 标题 + 地址，前台右下角一个悬浮按钮。
//
// 为什么不支持本地文件上传：
//   音频动辄几十 MB，存进 R2 再经 Worker 转发，费流量也费时间；而音频站 /
//   播客本身就有稳定直链，直接播它更省事，也不占仓库空间与这张卡里的配额。
//
// 为什么列表塞进 settings 的 JSON，不新建表：
//   条数少（上限 60）、渲染时整表读一次就够，为它单开一张表加一次迁移不划算
//   —— 与 Ver 0.5 ② 侧边栏同一个取舍。
//
// 为什么不启用时「什么都不输出」：
//   布局层是按 panel() 的返回值决定要不要整段注入的 —— 没启用就连这段 CSS 与
//   /js/audio.js 的请求都不会发出去，页面 DOM 与没有这功能时完全一致。
// ============================================================

import { esc } from './util.js';

// 条数上限：再多就不像「站点背景音」而像个音乐库了，
// 面板列表也会长到不好翻（前台列表区自带滚动）。
export const AUDIO_MAX = 60;
const TITLE_MAX = 80;
const URL_MAX = 500;

// 开关：默认关。只有后台显式存成 '1' 才算启用 ——
// 与 toc（未设置即开）相反，这里未设置即关。
export const enabled = (s) => String((s && s.get ? s.get('audio_on') : '') || '') === '1';

// 地址白名单：只认 http(s):// 与站内绝对路径（/ 开头）。
// 拒掉引号、尖括号、空白与反斜杠 —— 它最后会进 HTML 属性，
// 同时挡住 javascript: / data: 这类伪协议。
export function safeAudioUrl(v) {
  const u = String(v == null ? '' : v).trim();
  if (!/^(https?:\/\/|\/)/i.test(u)) return '';
  if (/[<>"'\s\\]/.test(u)) return '';
  return u.slice(0, URL_MAX);
}

// 标题会出现在面板与列表里，且会进 HTML 属性：剥掉尖括号，压平空白。
export function safeTitle(v) {
  return String(v == null ? '' : v)
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TITLE_MAX);
}

// 是不是 HLS 直播流：只看扩展名，忽略 ?query 与 #hash。
// 只有它需要额外引入解析库（Safari 原生就能放，其它浏览器靠 hls.js）。
export function isHls(u) {
  const tail = String(u || '').split('#')[0].split('?')[0].toLowerCase();
  return /\.m3u8$/.test(tail);
}

// 把后台存的东西（JSON 字符串，也容忍已经是数组）洗成安全列表。
// 脏条目直接丢弃 —— 最多是少一条音频，绝不把坏值带到页面上。
export function normalizeAudio(raw) {
  let arr = [];
  if (Array.isArray(raw)) arr = raw;
  else if (typeof raw === 'string' && raw.trim()) {
    try {
      const p = JSON.parse(raw);
      if (Array.isArray(p)) arr = p;
    } catch (e) { arr = []; }
  }
  const out = [];
  for (const one of arr.slice(0, AUDIO_MAX)) {
    const it = (one && typeof one === 'object') ? one : {};
    const url = safeAudioUrl(it.url);
    if (!url) continue;                       // 没地址的条目毫无意义
    out.push({ title: safeTitle(it.title) || '未命名音频', url });
  }
  return out;
}

// 当前配置下的播放列表（已清洗）
export function list(s) {
  return normalizeAudio(s && s.get ? s.get('audio_list') : '');
}

// 面板标题：没填就用「音频」
export function titleOf(s) {
  return safeTitle(s && s.get ? s.get('audio_title') : '') || '音频';
}

// ---------- 悬浮按钮图标 ----------
const SVG = (inner) => '<svg viewBox="0 0 24 24" aria-hidden="true">' + inner + '</svg>';
const STROKE = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
// 音符 = 待机；声波 = 正在播（由 .playing 类切换，见 CSS）
const NOTE_SVG = SVG('<g ' + STROKE + '><path d="M9 17V5l11-2v12"/><circle cx="6" cy="17" r="3"/><circle cx="17" cy="15" r="3"/></g>');
const WAVE_SVG = SVG('<g ' + STROKE + '><path d="M3 12h2M8 7v10M13 4v16M18 8v8M21 11v2"/></g>');

// ---------- 样式 ----------
// 只在启用且列表非空时由布局层输出（panel() 返回空串时这段整个不出现）。
// 取色全走 CSS 变量，所以夜间模式与换主题都跟着变。
export const AUDIO_CSS = `
.au{position:fixed;right:24px;bottom:24px;z-index:60;font-size:14px;line-height:1.5}
.au-btn{width:52px;height:52px;padding:0;border:0;border-radius:50%;cursor:pointer;
  display:flex;align-items:center;justify-content:center;background:var(--accent);color:var(--on-accent);
  box-shadow:0 6px 20px rgba(15,23,42,.25);transition:transform .16s,box-shadow .16s}
.au-btn:hover{transform:translateY(-2px);box-shadow:0 10px 26px rgba(15,23,42,.3)}
.au-btn svg{width:24px;height:24px;display:block}
/* 待机露音符、播放中露声波；声波同时轻轻呼吸，一眼看出还响着 */
.au-btn .au-ic-wave{display:none}
.au.playing .au-btn .au-ic-note{display:none}
.au.playing .au-btn .au-ic-wave{display:block}
@keyframes au-pulse{0%,100%{box-shadow:0 6px 20px rgba(15,23,42,.25),0 0 0 0 var(--accent)}
  70%{box-shadow:0 6px 20px rgba(15,23,42,.25),0 0 0 12px rgba(0,0,0,0)}}
.au.playing .au-btn{animation:au-pulse 2.2s ease-out infinite}

.au-panel{position:absolute;right:0;bottom:64px;width:328px;max-width:calc(100vw - 48px);
  background:var(--card);color:var(--text);border:1px solid var(--line);border-radius:16px;
  padding:14px;box-shadow:0 16px 44px rgba(15,23,42,.2);display:none}
.au.open .au-panel{display:block}
.au-hd{display:flex;align-items:center;gap:8px;margin-bottom:9px}
.au-hd b{flex:1;min-width:0;font-size:14.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.au-x{flex:none;width:26px;height:26px;padding:0;border:0;border-radius:8px;background:transparent;
  color:var(--muted);font-size:19px;line-height:1;cursor:pointer}
.au-x:hover{background:var(--tint);color:var(--text)}
.au-now{display:flex;align-items:center;gap:7px;margin-bottom:9px;min-height:20px}
.au-t{flex:1;min-width:0;font-size:13.5px;color:var(--text-soft);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.au-live{flex:none;font-size:11px;font-weight:700;letter-spacing:.5px;padding:1px 7px;border-radius:999px;
  background:var(--accent-soft);color:var(--accent)}
.au-rng{-webkit-appearance:none;appearance:none;width:100%;height:4px;border-radius:2px;display:block;
  background:var(--line);margin:0 0 11px;cursor:pointer;outline:none}
.au-rng::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:12px;height:12px;border:0;
  border-radius:50%;background:var(--accent);cursor:pointer}
.au-rng::-moz-range-thumb{width:12px;height:12px;border:0;border-radius:50%;background:var(--accent);cursor:pointer}
.au-rng:disabled{opacity:.45;cursor:default}
.au-ctl{display:flex;align-items:center;gap:8px;margin-bottom:11px}
.au-ctl button{width:34px;height:34px;padding:0;border:1px solid var(--line);border-radius:10px;background:var(--card);
  color:var(--text-soft);cursor:pointer;display:flex;align-items:center;justify-content:center}
.au-ctl button:hover{border-color:var(--accent);color:var(--accent)}
.au-ctl svg{width:17px;height:17px;display:block}
.au-ctl .au-play{width:40px;height:40px;background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
.au-ctl .au-play:hover{color:var(--on-accent);filter:brightness(1.08)}
.au-ctl .au-play svg{width:19px;height:19px}
.au-play .au-ic-pause{display:none}
.au-play.on .au-ic-play{display:none}
.au-play.on .au-ic-pause{display:block}
.au-time{margin-left:auto;font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}
.au-list{list-style:none;margin:0;padding:0;max-height:184px;overflow-y:auto;display:grid;gap:2px}
.au-p{width:100%;display:flex;align-items:center;gap:9px;padding:6px 8px;border:0;border-radius:9px;
  background:transparent;color:var(--text-soft);font-size:13.5px;text-align:left;cursor:pointer}
.au-p:hover{background:var(--tint);color:var(--text)}
.au-p.on{background:var(--accent-soft);color:var(--accent);font-weight:600}
.au-pn{flex:none;width:19px;font-size:11.5px;color:var(--muted);font-variant-numeric:tabular-nums;text-align:right}
.au-p.on .au-pn{color:var(--accent)}
.au-pt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* 手机上按钮缩一点、贴边近一点；面板改成通栏（贴左 14px、贴右 14px），
   免得 328px 的宽度在窄屏上从右边撑出去。
   这里用宽度算而不是 position:fixed —— html 上的 .gray filter 会让 fixed 的
   参照物变成整个文档，灰度模式下会跟着页面一起滚走。 */
@media (max-width:640px){
  .au{right:14px;bottom:14px}
  .au-btn{width:46px;height:46px}
  .au-btn svg{width:21px;height:21px}
  .au-panel{width:calc(100vw - 28px);max-width:calc(100vw - 28px);bottom:60px;
    max-height:min(64vh,440px);overflow-y:auto}
  .au-list{max-height:150px}
}
`;

// ---------- 面板 HTML ----------
/**
 * 前台悬浮播放器。未启用 / 列表为空时返回空串 —— 布局层据此决定
 * 要不要连 CSS 与脚本一起注入。
 */
export function panel(s) {
  if (!enabled(s)) return '';
  const items = list(s);
  if (!items.length) return '';
  const lis = items.map((it, i) =>
    `<li><button type="button" class="au-p" data-i="${i}" data-t="${esc(it.title)}" data-u="${esc(it.url)}">` +
    `<span class="au-pn">${i + 1}</span><span class="au-pt">${esc(it.title)}</span></button></li>`).join('');
  return `<div class="au" id="au">
  <button type="button" class="au-btn" id="au-btn" aria-label="音频播放器" aria-expanded="false" title="音频播放器">
    <span class="au-ic-note">${NOTE_SVG}</span><span class="au-ic-wave">${WAVE_SVG}</span>
  </button>
  <div class="au-panel" id="au-panel" role="dialog" aria-label="${esc(titleOf(s))}">
    <div class="au-hd"><b>${esc(titleOf(s))}</b>
      <button type="button" class="au-x" id="au-x" aria-label="收起播放器">&times;</button></div>
    <div class="au-now"><span class="au-t" id="au-t">点下面列表选一条开始播放</span>
      <span class="au-live" id="au-live" hidden>直播</span></div>
    <audio id="au-a" preload="none"></audio>
    <input type="range" class="au-rng" id="au-rng" min="0" max="1000" value="0" aria-label="播放进度" disabled>
    <div class="au-ctl">
      <button type="button" id="au-prev" aria-label="上一个"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 6h2.5v12H7zM18.5 6v12L9.6 12z"/></svg></button>
      <button type="button" class="au-play" id="au-play" aria-label="播放"><span class="au-ic-play"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg></span><span class="au-ic-pause"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5h3.5v14H7zm6.5 0H17v14h-3.5z"/></svg></span></button>
      <button type="button" id="au-next" aria-label="下一个"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M14.5 6H17v12h-2.5zM5.5 6l8.9 6-8.9 6z"/></svg></button>
      <span class="au-time" id="au-time">0:00 / 0:00</span>
    </div>
    <ul class="au-list" id="au-list">${lis}</ul>
  </div>
</div>`;
}

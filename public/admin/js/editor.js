// ============================================================
// 所见即所得编辑器（原生 contenteditable）
// 工具栏限制标签白名单 -> 保存时 html2md 转 Markdown 落库，
// 发布由服务端 Markdown 渲染器渲染为网页（两端语义一致）。
// ============================================================
import { dialog, esc, toast } from './ui.js';

const ALLOW = new Set([
  'p', 'div', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'strong', 'b', 'em', 'i', 'del', 's', 'u', 'blockquote',
  'pre', 'code', 'ul', 'ol', 'li', 'a', 'img',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'span', 'hr', 'figure',
  // 多媒体与外站嵌入（Ver 0.5 ⑥）
  'video', 'audio', 'iframe',
]);
// controls / preload / playsinline 必须放行：保存后重新打开文章时，
// 这些属性被剥掉的话编辑器里的播放器就变成一个点了没反应的方块。
const ATTR = {
  a: ['href', 'title'], img: ['src', 'alt'],
  th: ['colspan', 'rowspan'], td: ['colspan', 'rowspan'], code: ['class'],
  video: ['src', 'poster', 'controls', 'preload', 'playsinline', 'muted', 'loop', 'contenteditable'],
  audio: ['src', 'controls', 'preload', 'muted', 'loop', 'contenteditable'],
  iframe: ['src', 'allowfullscreen', 'title', 'loading', 'contenteditable'],
};

// 能当播放器嵌进来的站点（与服务端 embed.js 同口径，客户端只是先挡一道，真正的闸门在服务端）
const EMBED_URL = /^https?:\/\/(?:[\w-]+\.)*(?:bilibili\.com|b23\.tv|youtube\.com|youtu\.be|youtube-nocookie\.com)(?:[/:?#]|$)/i;
const MEDIA_SRC = /^(https?:)?\/\//i;

function sanitizeNode(node) {
  if (node.nodeType === Node.COMMENT_NODE) { node.remove(); return; }
  if (node.nodeType === Node.TEXT_NODE) return;
  const tag = node.nodeName.toLowerCase();
  if (!ALLOW.has(tag)) {
    // 不支持的元素：保留文本内容并展开
    while (node.firstChild) node.parentNode.insertBefore(node.firstChild, node);
    node.remove();
    return;
  }
  for (const attr of [...node.attributes]) {
    if (!(ATTR[tag] || []).includes(attr.name)) node.removeAttribute(attr.name);
  }
  if (tag === 'a') {
    const href = node.getAttribute('href') || '';
    if (!/^(https?:|mailto:|tel:|\/|#)/i.test(href)) node.removeAttribute('href');
  }
  if (tag === 'img') {
    const src = node.getAttribute('src') || '';
    if (!/^(https?:)?\/\//i.test(src) && !src.startsWith('/')) node.remove();
  }
  if (tag === 'video' || tag === 'audio') {
    const src = node.getAttribute('src') || '';
    if (!MEDIA_SRC.test(src) && !src.startsWith('/')) { node.remove(); return; }
    const poster = node.getAttribute('poster') || '';
    if (poster && !MEDIA_SRC.test(poster) && !poster.startsWith('/')) node.removeAttribute('poster');
    if (tag === 'audio') node.removeAttribute('poster');
    // 设成「不可编辑的孤岛」：否则在 contenteditable 里点播放按钮会被当成定位光标，压根播不了
    node.setAttribute('contenteditable', 'false');
  }
  if (tag === 'iframe') {
    // 只留白名单站点的播放器：别的 iframe（包括粘贴进来的广告、追踪框）直接删掉
    const src = node.getAttribute('src') || '';
    if (!EMBED_URL.test(src)) { node.remove(); return; }
    node.setAttribute('contenteditable', 'false');
  }
  if (tag === 'span' && !node.textContent.trim()) node.remove();
  [...node.childNodes].forEach(sanitizeNode);
}
export function sanitize(root) {
  [...root.childNodes].forEach(sanitizeNode);
  return root;
}

// ---------- HTML -> Markdown ----------
const escMd = (t) =>
  String(t).replace(/([\\`*_{}\[\]()#+\-.!|>~])/g, '\\$1').replace(/\s*\n\s*/g, '\n');

// 多媒体 / 外站嵌入 -> Markdown 里**独占一行**的标签。服务端只认这一种形态，
// 并且输出时会把属性全部丢弃重建，所以这里只需要把「源地址」写对。
// 引号与尖括号会让这一行解析错位，直接删掉（URL 里本来也不该有）。
function mediaTagOf(el) {
  const tag = el.nodeName.toLowerCase();
  const clean = (v) => String(v || '').replace(/["<>]/g, '');
  if (tag === 'video' || tag === 'audio') {
    const src = clean(el.getAttribute('src'));
    if (!src) return '';
    const poster = tag === 'video' ? clean(el.getAttribute('poster')) : '';
    return `<${tag} src="${src}"${poster ? ` poster="${poster}"` : ''}></${tag}>`;
  }
  if (tag === 'iframe') {
    const src = clean(el.getAttribute('src'));
    if (!src) return '';
    return `<iframe src="${src}"></iframe>`;
  }
  return '';
}

function inlineMd(node) {
  if (!node) return '';
  if (node.nodeType === Node.TEXT_NODE) return escMd(node.data);
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const tag = node.nodeName.toLowerCase();
  const inner = () => [...node.childNodes].map(inlineMd).join('');
  switch (tag) {
    case 'br': return '\n';
    case 'strong': case 'b': return '**' + inner() + '**';
    case 'em': case 'i': return '*' + inner() + '*';
    case 'del': case 's': case 'strike': return '~~' + inner() + '~~';
    case 'code': return '`' + node.textContent.replace(/`/g, '\\`') + '`';
    case 'a': {
      const h = node.getAttribute('href') || '';
      return h ? '[' + inner() + '](' + h + ')' : inner();
    }
    case 'img': {
      const src = node.getAttribute('src') || '';
      const alt = node.getAttribute('alt') || '';
      return src ? '![' + alt + '](' + src + ')' : '';
    }
    case 'video': case 'audio': case 'iframe':
      return mediaTagOf(node);
    case 'p': case 'div': case 'span': case 'u': case 'figure': default:
      return inner();
  }
}

// 可出现在段落内部的块级标签（浏览器常把列表/表格等塞进外层 div，必须递归展开，
// 否则会被当行内文本拼接，导致列表序号与换行丢失）
const BLOCKY = new Set([
  'p', 'div', 'ul', 'ol', 'li', 'pre', 'blockquote', 'table',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'figure',
  // 播放器必须独占一块：跟文字挤在同一段里的话，Markdown 那行会既不是纯文字也不是纯媒体
  'video', 'audio', 'iframe',
]);

function splitBr(el) {
  const out = [];
  let buf = [];
  const flush = () => {
    const s = buf.map(inlineMd).join('').replace(/\n+$/, '').trim();
    if (s) out.push(s);
    buf = [];
  };
  for (const c of el.childNodes) {
    const isEl = c.nodeType === Node.ELEMENT_NODE;
    const t = isEl ? c.nodeName.toLowerCase() : '';
    if (t === 'br') { flush(); continue; }
    if (BLOCKY.has(t)) {
      flush();
      const rows = blockLines(c);
      // 前后各补一个空行：保证它与相邻文字是独立块（否则列表可能并入上一段）。
      // li 例外——列表项之间必须紧邻，补空行会把一个列表拆成多个。
      if (rows.length) { if (t === 'li') out.push(...rows); else out.push('', ...rows, ''); }
      continue;
    }
    buf.push(c);
  }
  flush();
  return out;
}

// 单个 <li> -> markdown 行（marker 形如 "- " 或 "1. "），子列表缩进两格
function liLines(li, marker) {
  const buf = [];
  const nests = [];
  for (const c of li.childNodes) {
    if (c.nodeType === Node.ELEMENT_NODE && ['ul', 'ol'].includes(c.nodeName.toLowerCase())) {
      nests.push(c);
    } else if (c.nodeType === Node.ELEMENT_NODE && ['p', 'div'].includes(c.nodeName.toLowerCase())) {
      buf.push(inlineMd(c).trim());
    } else {
      buf.push(inlineMd(c));
    }
  }
  const head = buf.join('').trim();
  if (!head && !nests.length) return [];
  const out = [marker + head];
  for (const n of nests) {
    for (const line of blockLines(n)) out.push('  ' + line);
  }
  return out;
}

// 块级元素 -> markdown 行数组
function blockLines(el) {
  const tag = el.nodeName.toLowerCase();
  const kids = [...el.childNodes];
  switch (tag) {
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
      const n = +tag[1];
      return ['#'.repeat(n) + ' ' + inlineMd(el).trim()];
    }
    case 'p': case 'div':
      return splitBr(el);
    case 'blockquote': {
      const lines = [];
      for (const k of kids) {
        const rows = blockLines(k);
        if (!rows.length) continue;
        if (lines.length) lines.push('>'); // 引用内段落间用 > 空行分隔
        for (const line of rows) lines.push('> ' + line);
      }
      return lines;
    }
    case 'pre': {
      let txt = el.textContent || '';
      txt = txt.replace(/^\n+|\n+$/g, '');
      // 保留语言标识：<pre><code class="hljs language-js"> → ```js（否则保存后高亮失效）
      const codeEl = el.querySelector('code');
      const cls = codeEl ? String(codeEl.className || '') : '';
      const m = /(?:^|\s)language-([A-Za-z0-9_+-]+)/.exec(cls);
      return ['```' + (m ? m[1] : ''), txt, '```'];
    }
    case 'hr': return ['---'];
    // 播放器 / 嵌入框：整行输出，不参与任何行内拼接
    case 'video': case 'audio': case 'iframe': {
      const line = mediaTagOf(el);
      return line ? [line] : [];
    }
    case 'ul': case 'ol': {
      const out = [];
      const ordered = tag === 'ol';
      let idx = 1;
      for (const li of kids) {
        if (li.nodeType !== Node.ELEMENT_NODE || li.nodeName.toLowerCase() !== 'li') continue;
        const marker = ordered ? idx++ + '. ' : '- ';
        out.push(...liLines(li, marker));
      }
      return out;
    }
    // 脱离 ul/ol 的孤立 li（粘贴或浏览器拆分所致）：按无序列表输出，避免整段内容丢失
    case 'li':
      return liLines(el, '- ');
    case 'table': {
      const rows = [...el.querySelectorAll('tr')];
      if (!rows.length) return [];
      const cellMd = (c) => inlineMd(c).trim().replace(/\|/g, '\\|');
      const toRow = (tr) => '| ' + [...tr.children].map(cellMd).join(' | ') + ' |';
      const out = [];
      const header = rows[0];
      const cols = [...header.children].length || 1;
      out.push(toRow(header));
      out.push('| ' + new Array(cols).fill('---').join(' | ') + ' |');
      for (const tr of rows.slice(1)) out.push(toRow(tr));
      return out;
    }
    default:
      return [...kids].flatMap(blockLines);
  }
}

// 将 .we 内容容器转成 Markdown 字符串
export function mdFromHtml(container) {
  sanitize(container);
  // 每个顶层块产出一组行；块与块之间用空行分隔（= Markdown 段落边界），
  // 块内换行（<br> 拆分出的行）保持单换行，渲染时再转 <br>，与所见即所得一致。
  const blocks = [];
  const add = (rows) => {
    if (rows && rows.some((r) => r.trim())) blocks.push(rows);
  };
  for (const c of [...container.childNodes]) {
    if (c.nodeType === Node.TEXT_NODE) {
      if (c.data.trim()) add([c.data.trim()]);
      continue;
    }
    if (c.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = c.nodeName.toLowerCase();
    if (tag === 'img') {
      const src = c.getAttribute('src') || '';
      const alt = c.getAttribute('alt') || '';
      if (src) add(['![' + alt + '](' + src + ')']);
      continue;
    }
    if (tag === 'br') continue;
    add(blockLines(c));
  }
  // 块间空行分隔；顺带压缩 3 个及以上连续空行
  let md = blocks.map((rows) => rows.join('\n')).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  return md;
}

// ---------- 编辑器类 ----------
const B = (k, label, cls) => ({ k, label, cls });

export class Editor {
  constructor(host, { ph = '开始写作…', upload, resolveEmbed } = {}) {
    this.upload = upload || (() => Promise.reject(new Error('未配置上传')));
    // 外站视频要出网解析（b23.tv 短链），所以交给外部注入，编辑器自身不依赖 API 层
    this.resolveEmbed = resolveEmbed || null;
    host.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'ed-card';
    div.innerHTML = `
      <div class="ed-tool" data-tool></div>
      <div class="ed-area"><div class="we" contenteditable="true" data-ph="${esc(ph)}" data-we></div></div>`;
    host.appendChild(div);
    this.tool = div.querySelector('[data-tool]');
    this.we = div.querySelector('[data-we]');
    this._buildToolbar();
    this._bindEvents();
  }

  setHTML(html) {
    const frag = document.createRange().createContextualFragment(html || '');
    sanitize(frag);
    this.we.innerHTML = '';
    this.we.appendChild(frag);
  }
  getHTML() { return this.we.innerHTML; }
  getMarkdown() {
    const clone = this.we.cloneNode(true);
    return mdFromHtml(clone);
  }
  isEmpty() { return !this.we.textContent.trim(); }

  _buildToolbar() {
    const add = (b) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tbtn' + (b.cls ? ' ' + b.cls : '');
      btn.innerHTML = b.label;
      btn.title = b.k;
      btn.dataset.k = b.k;
      this.tool.appendChild(btn);
      return btn;
    };
    const sep = () => { const s = document.createElement('span'); s.className = 'tl-sep'; this.tool.appendChild(s); };
    const groups = [
      [B('undo', '↶', 'undo'), B('redo', '↷', 'redo')],
      [B('fmtP', '正文', 'block'), B('fmtH2', '标题 2', 'block'), B('fmtH3', '标题 3', 'block'), B('fmtH4', '标题 4', 'block')],
      [B('bold', '<b>B</b>', 'bold'), B('italic', '<i>I</i>', 'italic'), B('strike', '<s>S</s>', 'strikeThrough')],
      [B('quote', '❝ 引用', 'block')],
      [B('ul', '• 列表', 'insertUnorderedList'), B('ol', '1. 列表', 'insertOrderedList')],
      [B('code', '&lt;/&gt; 行内码', 'inlineCode'), B('codeblock', '{ } 高亮代码', 'codeBlock')],
      [B('link', '🔗 链接', 'link'), B('unlink', '🔓 取消链接', 'unlink')],
      [B('img', '🖼 图片', 'image'), B('media', '🎬 多媒体', 'media')],
      [B('table', '▦ 表格', 'table')],
      [B('hr', '— 分割线', 'hr')],
      [B('clean', '⌫ 清除格式', 'clean')],
    ];
    for (const g of groups) {
      for (const b of g) add(b);
      sep();
    }
  }

  _exec(name) {
    const selText = () => (window.getSelection() ? window.getSelection().toString() : '');
    const wrapSel = (html) => document.execCommand('insertHTML', false, html);
    switch (name) {
      case 'undo': document.execCommand('undo'); break;
      case 'redo': document.execCommand('redo'); break;
      case 'fmtP': document.execCommand('formatBlock', false, 'p'); break;
      case 'fmtH2': document.execCommand('formatBlock', false, 'h2'); break;
      case 'fmtH3': document.execCommand('formatBlock', false, 'h3'); break;
      case 'fmtH4': document.execCommand('formatBlock', false, 'h4'); break;
      case 'bold': document.execCommand('bold'); break;
      case 'italic': document.execCommand('italic'); break;
      case 'strike': document.execCommand('strikeThrough'); break;
      case 'block': case 'quote': document.execCommand('formatBlock', false, 'blockquote'); break;
      case 'ul': document.execCommand('insertUnorderedList'); break;
      case 'ol': document.execCommand('insertOrderedList'); break;
      case 'inlineCode': case 'code': {
        const t = selText();
        if (t) { wrapSel('<code>' + esc(t) + '</code>'); break; }
        // 无选区：弹窗让用户输入代码内容，避免"点了没反应"
        this._inlineCodeDialog();
        break;
      }
      case 'codeBlock': case 'codeblock': this._codeBlockDialog(); break;
      case 'link': {
        const t = selText();
        this._linkDialog(t);
        break;
      }
      case 'unlink': document.execCommand('unlink'); break;
      case 'image': case 'img': this._imageDialog(); break;
      case 'media': this._mediaDialog(); break;
      case 'table': this._insertTable(); break;
      case 'hr': document.execCommand('insertHorizontalRule'); break;
      case 'clean': document.execCommand('removeFormat'); document.execCommand('formatBlock', false, 'p'); break;
    }
    this.we.focus();
  }

  async _insertTable() {
    let rows = 3, cols = 3;
    const res = await dialog({
      title: '插入表格',
      bodyHtml: `<div style="display:flex;gap:14px">
        <div class="field" style="flex:1"><label>行数</label><input class="inp" id="dlg-rows" type="number" min="2" max="30" value="3"></div>
        <div class="field" style="flex:1"><label>列数</label><input class="inp" id="dlg-cols" type="number" min="2" max="10" value="3"></div>
      </div><div class="hint">发布后表格外观与前台一致；编辑时直接点格子打字，单元格内换行用 Shift+Enter。</div>`,
      actions: [{ val: 'ok', label: '插入', cls: 'p' }, { val: 'cancel', label: '取消', cls: 'g' }],
      onSubmit: (body) => {
        rows = parseInt(body.querySelector('#dlg-rows').value, 10) || 0;
        cols = parseInt(body.querySelector('#dlg-cols').value, 10) || 0;
        if (rows < 2 || cols < 2) return false;
      },
    });
    if (res !== 'ok' || rows < 2 || cols < 2) return;
    const mkCell = (tag) => `<${tag}><br></${tag}>`;
    let html = '<table><tbody>';
    for (let r = 0; r < rows; r++) {
      html += '<tr>';
      for (let c = 0; c < cols; c++) html += mkCell(r === 0 ? 'th' : 'td');
      html += '</tr>';
    }
    html += '</tbody></table>';
    document.execCommand('insertHTML', false, html);
    const tbl = this.we.querySelector('table:last-of-type');
    if (tbl) {
      const first = tbl.querySelector('td, th');
      if (first) {
        const r = document.createRange();
        r.selectNodeContents(first);
        r.collapse(true);
        const s = window.getSelection();
        s.removeAllRanges();
        s.addRange(r);
      }
    }
  }

  // ---------- 弹窗式插入（图片 / 代码 / 链接），统一走站内 dialog，不再依赖浏览器原生弹窗 ----------

  // 行内代码：无选区时弹窗输入
  async _inlineCodeDialog() {
    let txt = '';
    const res = await dialog({
      title: '插入行内代码',
      bodyHtml: `<div class="field"><label>代码内容</label>
        <input class="inp" id="dlg-codetext" placeholder="例如：const a = 1" style="width:100%"></div>
        <div class="hint">提示：也可先在正文中选中文字再点「行内码」，选中的内容会直接变成代码。</div>`,
      actions: [{ val: 'ok', label: '插入', cls: 'p' }, { val: 'cancel', label: '取消', cls: 'g' }],
      onSubmit: (b) => {
        txt = String((b.querySelector('#dlg-codetext') || {}).value || '').trim();
        return !!txt;
      },
    });
    if (res !== 'ok' || !txt) return;
    this.we.focus();
    document.execCommand('insertHTML', false, '<code>' + esc(txt) + '</code>');
  }

  // 高亮代码块：语言下拉选择，输出标准 <pre><code class="language-x">（与 WordPress / Typecho 通用）
  async _codeBlockDialog() {
    // 可选语言（与服务端高亮器 hl.js 的支持范围一致）
    const LANGS = [
      ['', '纯文本（不高亮）'],
      ['javascript', 'JavaScript / JS'],
      ['typescript', 'TypeScript / TS'],
      ['python', 'Python'],
      ['bash', 'Bash / Shell'],
      ['html', 'HTML / XML'],
      ['css', 'CSS / SCSS'],
      ['json', 'JSON'],
      ['yaml', 'YAML'],
      ['sql', 'SQL'],
      ['java', 'Java'],
      ['c', 'C'],
      ['cpp', 'C++'],
      ['csharp', 'C#'],
      ['go', 'Go'],
      ['rust', 'Rust'],
      ['php', 'PHP'],
      ['markdown', 'Markdown'],
      ['diff', 'Diff 差异'],
      ['ini', 'INI / TOML / 配置文件'],
    ];
    const opts = LANGS.map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
    // 若已选中文字，直接带入代码区
    let preset = '';
    try { preset = selText(); } catch (e) { preset = ''; }
    let lang = '', code = '';
    const res = await dialog({
      title: '插入高亮代码块',
      bodyHtml: `<div class="field"><label>代码语言（决定高亮配色）</label>
        <select class="inp" id="dlg-cblang" style="width:100%">${opts}</select></div>
        <div class="field" style="margin-top:12px"><label>代码内容（可留空，插入后直接在代码区内输入）</label>
        <textarea class="inp" id="dlg-cbcode" rows="9" style="width:100%;resize:vertical;font-family:Consolas,Menlo,monospace" placeholder="在这里粘贴代码…（缩进与换行会原样保留）">${preset.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</textarea></div>
        <p class="hint" style="margin-bottom:0">小技巧：先选中正文里的代码再点本按钮，会自动带入。语言标识与 WordPress / Typecho 通用，文章互搬不会错乱。</p>`,
      actions: [{ val: 'ok', label: '插入', cls: 'p' }, { val: 'cancel', label: '取消', cls: 'g' }],
      onSubmit: (b) => {
        lang = String((b.querySelector('#dlg-cblang') || {}).value || '').trim();
        code = String((b.querySelector('#dlg-cbcode') || {}).value || '').replace(/\r\n/g, '\n');
        return true;
      },
    });
    if (res !== 'ok') return;
    const pre = document.createElement('pre');
    const c = document.createElement('code');
    if (lang) c.className = 'hljs language-' + lang.replace(/[^A-Za-z0-9_+\-]/g, '');
    else c.className = 'hljs';
    c.textContent = code || ' ';
    pre.appendChild(c);
    this.we.focus();
    document.execCommand('insertHTML', false, pre.outerHTML);
    const last = this.we.querySelector('pre:last-of-type');
    if (last) {
      const r = document.createRange();
      r.selectNodeContents(last.querySelector('code') || last);
      r.collapse(false);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
    }
  }

  // 链接：sel 为当前选中的文字（可能为空）
  async _linkDialog(sel) {
    let url = '', text = '';
    const res = await dialog({
      title: '插入链接',
      bodyHtml: `<div class="field"><label>链接地址</label>
        <input class="inp" id="dlg-url" value="https://" style="width:100%"></div>
        <div class="field" style="margin-top:12px"><label>显示文字（留空则${sel ? '使用选中的文字' : '显示链接地址本身'}）</label>
        <input class="inp" id="dlg-ltxt" style="width:100%"></div>
        <div class="hint">支持 http(s)://、mailto:、tel: 或以 / 开头的站内路径。</div>`,
      actions: [{ val: 'ok', label: '插入', cls: 'p' }, { val: 'cancel', label: '取消', cls: 'g' }],
      onSubmit: (b) => {
        url = String((b.querySelector('#dlg-url') || {}).value || '').trim();
        text = String((b.querySelector('#dlg-ltxt') || {}).value || '').trim();
        return !!url && /^(https?:|mailto:|tel:|\/|#)/i.test(url);
      },
    });
    if (res !== 'ok' || !url) return;
    this.we.focus();
    if (sel) {
      document.execCommand('createLink', false, url);
    } else {
      const t = text || url;
      document.execCommand('insertHTML', false, '<a href="' + esc(url) + '">' + esc(t) + '</a>');
    }
  }

  // 图片：弹窗里选择「上传」或「填链接」
  async _imageDialog() {
    let file = null, url = '';
    const res = await dialog({
      title: '插入图片',
      bodyHtml: `<div class="field"><label>方式一 · 从电脑上传（保存到本站媒体库，推荐）</label>
        <input type="file" id="dlg-imgfile" accept="image/png,image/jpeg,image/gif,image/webp,image/avif,image/bmp" class="inp"></div>
        <div class="field" style="margin-top:12px"><label>方式二 · 使用图片链接</label>
        <input class="inp" id="dlg-imgurl" placeholder="https://… 或以 / 开头的站内路径" style="width:100%"></div>
        <div class="hint">两种方式任选其一即可插入图片。</div>`,
      actions: [{ val: 'ok', label: '插入', cls: 'p' }, { val: 'cancel', label: '取消', cls: 'g' }],
      onSubmit: (b) => {
        file = ((b.querySelector('#dlg-imgfile') || {}).files || [])[0] || null;
        url = String((b.querySelector('#dlg-imgurl') || {}).value || '').trim();
        return !!(file || url);
      },
    });
    if (res !== 'ok' || (!file && !url)) return;
    this.we.focus();
    if (file) {
      try {
        const src = await this.upload(file);
        document.execCommand('insertHTML', false, `<img src="${esc(src)}" alt="${esc(file.name || '')}" loading="lazy">`);
      } catch (e) { toast((e && e.message) || '上传失败', 'bad'); }
      return;
    }
    if (!/^(https?:)?\/\//i.test(url) && !url.startsWith('/')) {
      toast('图片链接需以 http(s):// 或 / 开头', 'bad');
      return;
    }
    document.execCommand('insertHTML', false, `<img src="${esc(url)}" alt="" loading="lazy">`);
  }

  // 多媒体：视频 / 音频 / 外站嵌入。版式与「插入图片」一致 —— 同样两种方式（上传 / 链接），
  // 区别只在成品：插入的是一个**能直接点击播放的播放器**，而不是一张静态图。
  async _mediaDialog() {
    let file = null, url = '', posterFile = null, kind = 'auto';
    const res = await dialog({
      title: '插入多媒体',
      bodyHtml: `<div class="field"><label>方式一 · 从电脑上传（保存到本站媒体库，推荐）</label>
        <input type="file" id="dlg-mfile" accept="video/*,audio/*" class="inp"></div>
        <div class="field" style="margin-top:12px"><label>方式二 · 使用链接</label>
        <input class="inp" id="dlg-murl" placeholder="以 .mp4 / .mp3 结尾的直链，或 B 站、YouTube 的视频页地址" style="width:100%"></div>
        <div class="field" style="margin-top:12px"><label>类型（填链接时生效，上传的按文件自动识别）</label>
        <label class="chk-line" style="display:inline-flex;margin-right:16px"><input type="radio" name="dlg-mkind" value="auto" checked> 自动识别</label>
        <label class="chk-line" style="display:inline-flex;margin-right:16px"><input type="radio" name="dlg-mkind" value="video"> 视频</label>
        <label class="chk-line" style="display:inline-flex"><input type="radio" name="dlg-mkind" value="audio"> 音频</label></div>
        <div class="field" style="margin-top:12px"><label>视频封面（可选，留空就显示视频首帧）</label>
        <input type="file" id="dlg-mposter" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" class="inp"></div>
        <p class="hint" style="margin-bottom:0">两种方式任选其一即可。视频最大 80MB、音频最大 20MB；插入后就是一排可以点击播放的控件。B 站 / YouTube 的视频页地址会自动换成内嵌播放器，b23.tv 分享短链也认。</p>`,
      actions: [{ val: 'ok', label: '插入', cls: 'p' }, { val: 'cancel', label: '取消', cls: 'g' }],
      onSubmit: (b) => {
        file = ((b.querySelector('#dlg-mfile') || {}).files || [])[0] || null;
        url = String((b.querySelector('#dlg-murl') || {}).value || '').trim();
        posterFile = ((b.querySelector('#dlg-mposter') || {}).files || [])[0] || null;
        const r = b.querySelector('input[name="dlg-mkind"]:checked');
        kind = r ? r.value : 'auto';
        return !!(file || url);
      },
    });
    if (res !== 'ok' || (!file && !url)) return;
    // 先抢回正文焦点：上传要等好几秒，等回来再聚焦插入位置就丢了
    this.we.focus();

    if (file) {
      const mt = String(file.type || '').toLowerCase();
      const isVideo = mt.startsWith('video/');
      const isAudio = mt.startsWith('audio/');
      if (!isVideo && !isAudio) { toast('请选择视频或音频文件', 'bad'); return; }
      try {
        const src = await this.upload(file);
        const poster = isVideo && posterFile ? await this._uploadPoster(posterFile) : '';
        this._insertMedia(isVideo ? 'video' : 'audio', src, poster);
        toast(isVideo ? '视频已插入，点击即可播放' : '音频已插入，点击即可播放');
      } catch (e) { toast((e && e.message) || '上传失败', 'bad'); }
      return;
    }

    const full = url.startsWith('//') ? 'https:' + url : url;
    if (EMBED_URL.test(full)) {
      if (!this.resolveEmbed) { toast('未配置外站嵌入解析', 'bad'); return; }
      try {
        this._insertMedia('iframe', await this.resolveEmbed(full));
        toast('已插入内嵌播放器');
      } catch (e) { toast((e && e.message) || '嵌入失败', 'bad'); }
      return;
    }
    if (!MEDIA_SRC.test(url) && !url.startsWith('/')) {
      toast('链接需以 http(s):// 或 / 开头', 'bad');
      return;
    }
    const t = kind === 'auto'
      ? (/\.(mp3|m4a|aac|wav|flac|ogg|oga|opus|weba)([?#]|$)/i.test(url) ? 'audio' : 'video')
      : kind;
    this._insertMedia(t, url);
  }

  // 封面图就是普通图片，走同一条上传通道；传不上去也不该挡住正文插入
  async _uploadPoster(f) {
    try { return await this.upload(f); } catch (e) { toast('封面没传上去，已改用视频首帧', 'bad'); return ''; }
  }

  // 插入的成品一律是真实标签：编辑器里当场可播，前台同理
  _insertMedia(tag, src, poster = '') {
    const s = String(src || '');
    if (!s) { toast('没有拿到可用的地址', 'bad'); return; }
    this.we.focus();
    const attr = tag === 'video'
      ? `src="${esc(s)}"${poster ? ` poster="${esc(poster)}"` : ''} controls preload="metadata" playsinline`
      : tag === 'audio'
        ? `src="${esc(s)}" controls preload="metadata"`
        : `src="${esc(s)}" loading="lazy" allowfullscreen`;
    document.execCommand('insertHTML', false, `<${tag} ${attr} contenteditable="false"></${tag}>`);
  }

  _bindEvents() {
    this.tool.addEventListener('mousedown', (e) => e.preventDefault());
    this.tool.addEventListener('click', (e) => {
      const btn = e.target.closest('.tbtn');
      if (!btn) return;
      const k = btn.dataset.k;
      try {
        // 图片与多媒体各自弹窗，不能在 _exec 里收尾 focus（会把焦点从输入框抢回正文）
        if (k === 'image' || k === 'media') { this._exec(k); return; }
        this._exec(k);
      } catch (err) {
        // 任何隐藏异常都以红字提示暴露，避免"点了没反应"
        toast((err && err.message) || '操作失败，请重试', 'bad');
      }
    });
    const refresh = () => this._refreshState();
    document.addEventListener('selectionchange', refresh);
    this.we.addEventListener('input', refresh);
  }

  _refreshState() {
    const map = { bold: 'bold', italic: 'italic', strike: 'strikeThrough' };
    for (const [k, cmd] of Object.entries(map)) {
      const btn = this.tool.querySelector(`[data-k="${k}"]`);
      if (btn) btn.classList.toggle('on', !!document.queryCommandState(cmd));
    }
    const fmt = document.queryCommandValue('formatBlock') || '';
    const blockMap = { p: 'fmtP', h2: 'fmtH2', h3: 'fmtH3', h4: 'fmtH4', blockquote: 'quote' };
    for (const k of Object.keys(blockMap)) {
      const btn = this.tool.querySelector(`[data-k="${blockMap[k]}"]`);
      if (btn) btn.classList.toggle('on', fmt.toLowerCase().indexOf(k) > -1);
    }
  }
}

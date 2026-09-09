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
]);
const ATTR = { a: ['href', 'title'], img: ['src', 'alt'], th: ['colspan', 'rowspan'], td: ['colspan', 'rowspan'], code: ['class'] };

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
    case 'p': case 'div': case 'span': case 'u': case 'figure': default:
      return inner();
  }
}

// 可出现在段落内部的块级标签（浏览器常把列表/表格等塞进外层 div，必须递归展开，
// 否则会被当行内文本拼接，导致列表序号与换行丢失）
const BLOCKY = new Set([
  'p', 'div', 'ul', 'ol', 'li', 'pre', 'blockquote', 'table',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'figure',
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
  constructor(host, { ph = '开始写作…', upload } = {}) {
    this.upload = upload || (() => Promise.reject(new Error('未配置上传')));
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
      [B('img', '🖼 图片', 'image')],
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

  _bindEvents() {
    this.tool.addEventListener('mousedown', (e) => e.preventDefault());
    this.tool.addEventListener('click', (e) => {
      const btn = e.target.closest('.tbtn');
      if (!btn) return;
      const k = btn.dataset.k;
      try {
        if (k === 'image') { this._exec('image'); return; }
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

// ============================================================
// 所见即所得编辑器（原生 contenteditable）
// 工具栏限制标签白名单 -> 保存时 html2md 转 Markdown 落库，
// 发布由服务端 Markdown 渲染器渲染为网页（两端语义一致）。
// ============================================================
import { dialog, esc } from './ui.js';

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

function splitBr(el) {
  const segs = [[]];
  for (const c of el.childNodes) {
    if (c.nodeType === Node.ELEMENT_NODE && c.nodeName.toLowerCase() === 'br') segs.push([]);
    else segs[segs.length - 1].push(c);
  }
  return segs.filter((s) => s.length).map((nodes) => nodes.map(inlineMd).join('')).filter((s) => s.trim());
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
        for (const line of blockLines(k)) lines.push('> ' + line);
      }
      return lines;
    }
    case 'pre': {
      let txt = el.textContent || '';
      txt = txt.replace(/^\n+|\n+$/g, '');
      return ['```', txt, '```'];
    }
    case 'hr': return ['---'];
    case 'ul': case 'ol': {
      const out = [];
      const ordered = tag === 'ol';
      let idx = 1;
      for (const li of kids) {
        if (li.nodeType !== Node.ELEMENT_NODE || li.nodeName.toLowerCase() !== 'li') continue;
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
        const marker = ordered ? idx + '. ' : '- ';
        const head = buf.join('').trim();
        if (ordered) idx++;
        if (!head && !nests.length) continue;
        out.push(marker + head);
        for (const n of nests) {
          for (const line of blockLines(n)) out.push('  ' + line);
        }
      }
      return out;
    }
    case 'li':
      return []; // li 只在其 ul/ol 内部处理
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
    case 'li':
      return []; // li 只在其 ul/ol 内部处理
    default:
      return [...kids].flatMap(blockLines);
  }
}

// 将 .we 内容容器转成 Markdown 字符串
export function mdFromHtml(container) {
  sanitize(container);
  const lines = [];
  for (const c of [...container.childNodes]) {
    if (c.nodeType === Node.TEXT_NODE) {
      if (c.data.trim()) lines.push(c.data.trim());
      continue;
    }
    if (c.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = c.nodeName.toLowerCase();
    if (tag === 'img') {
      const src = c.getAttribute('src') || '';
      const alt = c.getAttribute('alt') || '';
      if (src) lines.push('![' + alt + '](' + src + ')');
      continue;
    }
    if (tag === 'br') continue;
    lines.push(...blockLines(c));
  }
  // 合并空行，压缩多余空行
  let md = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
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
    this.fileInput = document.createElement('input');
    this.fileInput.type = 'file';
    this.fileInput.accept = 'image/png,image/jpeg,image/gif,image/webp,image/avif,image/bmp';
    this.fileInput.style.display = 'none';
    div.appendChild(this.fileInput);
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
      [B('code', '&lt;/&gt; 行内码', 'inlineCode'), B('codeblock', '{ } 代码块', 'codeBlock')],
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
      case 'block': document.execCommand('formatBlock', false, 'blockquote'); break;
      case 'ul': document.execCommand('insertUnorderedList'); break;
      case 'ol': document.execCommand('insertOrderedList'); break;
      case 'inlineCode': {
        const t = selText();
        wrapSel('<code>' + esc(t) + '</code>');
        break;
      }
      case 'codeBlock': {
        const lang = window.prompt('代码语言标识（可留空，如 js / python）') || '';
        const node = document.createElement('pre');
        const code = document.createElement('code');
        if (lang) code.className = 'language-' + lang;
        code.textContent = ' ';
        node.appendChild(code);
        wrapSel(node.outerHTML);
        const pre = this.we.querySelector('pre:last-of-type');
        if (pre) {
          const r = document.createRange();
          r.selectNodeContents(pre.querySelector('code') || pre);
          r.collapse(false);
          const s = window.getSelection();
          s.removeAllRanges();
          s.addRange(r);
        }
        break;
      }
      case 'link': {
        const href = window.prompt('链接地址：', 'https://');
        if (!href) break;
        if (selText()) document.execCommand('createLink', false, href);
        else wrapSel('<a href="' + esc(href) + '">' + esc(href) + '</a>');
        break;
      }
      case 'unlink': document.execCommand('unlink'); break;
      case 'image': this.fileInput.click(); break;
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

  _bindEvents() {
    this.tool.addEventListener('mousedown', (e) => e.preventDefault());
    this.tool.addEventListener('click', (e) => {
      const btn = e.target.closest('.tbtn');
      if (!btn) return;
      const k = btn.dataset.k;
      if (k === 'image') {
        this._exec('image');
        return;
      }
      this._exec(k);
    });
    this.fileInput.addEventListener('change', async () => {
      const file = this.fileInput.files && this.fileInput.files[0];
      this.fileInput.value = '';
      if (!file) return;
      const url = await this.upload(file);
      this.we.focus();
      document.execCommand('insertHTML', false, `<img src="${esc(url)}" alt="${esc(file.name)}" loading="lazy">`);
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

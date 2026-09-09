// ============================================================
// 轻量 Markdown 渲染器（GFM 常用子集），Worker 端专用
// 输出一律先转义，杜绝 XSS。支持：
//   标题(#~######) / 引用 / 无序·有序列表 / 任务列表 / 代码围栏
//   行内代码 / 加粗 / 斜体 / 删除线 / 链接 / 图片 / 表格 / 分割线 / 转义
// 说明：不支持 setext 标题与多层列表嵌套（缩进内容会并入上一项）。
// ============================================================
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC_MAP[c]);

import { highlight, normalizeLang } from './hl.js';

const SAFE_PROTO = /^(https?:|mailto:|tel:|#|\/)/i;
const ESC_CHARS = '\\`*_[]{}()#+-.!|>~';

// 允许的图片 src：http(s)、相对路径或站内 /media
function safeSrc(u) {
  u = String(u || '').trim();
  if (/^(https?:)?\/\//i.test(u) || u.startsWith('/') || SAFE_PROTO.test(u)) return u;
  return null;
}
function safeHref(u) {
  u = String(u || '').trim();
  if (u.startsWith('/') || u.startsWith('#') || /^(https?:|mailto:|tel:)/i.test(u)) return u;
  return null;
}

// 行内解析：手工状态机
function inline(src) {
  let out = '', plain = '', i = 0;
  const flush = () => { if (plain) { out += esc(plain); plain = ''; } };
  const pushText = (t) => { plain += t; };

  const findParen = (k) => {
    let q = null, depth = 1;
    for (let j = k; j < src.length; j++) {
      const ch = src[j];
      if (q) { if (ch === q && src[j - 1] !== '\\') q = null; continue; }
      if (ch === '"' || ch === "'") { q = ch; continue; }
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) return j; }
    }
    return -1;
  };
  const splitTarget = (t) => {
    t = t.trim();
    const m = /^(\S+)(?:\s+["']([\s\S]*?)["'])?\s*$/.exec(t);
    return { url: m ? m[1] : t, title: m && m[2] != null ? m[2] : null };
  };
  const tryBracket = (isImg) => {
    // 从 i 处 '[' 或 '![' 开始解析 [text](url)
    let open = 0;
    for (let j = i + (isImg ? 2 : 1); j < src.length; j++) {
      const ch = src[j];
      if (ch === '[') open++;
      else if (ch === ']') {
        if (open === 0) {
          if (src[j + 1] === '(') {
            const close = findParen(j + 2);
            if (close > -1) {
              const text = src.slice(i + (isImg ? 2 : 1), j);
              const { url, title } = splitTarget(src.slice(j + 2, close));
              const end = close + 1;
              if (isImg) {
                const su = safeSrc(url);
                if (!su) return -1;
                flush();
                out += `<img src="${esc(su)}" alt="${esc(text)}" loading="lazy"${title ? ` title="${esc(title)}"` : ''}>`;
              } else {
                const href = safeHref(url);
                if (href == null) return -1;
                const external = /^https?:/i.test(href);
                flush();
                out += `<a href="${esc(href)}"${title ? ` title="${esc(title)}"` : ''}${external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${inline(text)}</a>`;
              }
              i = end;
              return 1;
            }
          }
          break;
        }
        open--;
      }
    }
    return -1;
  };

  while (i < src.length) {
    const c = src[i];
    const two = src.slice(i, i + 2);

    // 段落内的软换行（编辑器按 Enter 产生的行分隔、旧数据单换行等）保留为可见换行
    if (c === '\n') { flush(); out += '<br>\n'; i++; continue; }

    if (c === '\\' && i + 1 < src.length && ESC_CHARS.includes(src[i + 1])) { pushText(src[i + 1]); i += 2; continue; }

    if (c === '`') {
      const end = src.indexOf('`', i + 1);
      if (end > -1) {
        let code = src.slice(i + 1, end), len = end - i + 1;
        if (src[end + 1] === '`' && src[i - 1] !== '`') { // 双反引号包裹（可含单个反引号）
          const end2 = src.indexOf('``', end + 1);
          if (end2 > -1) { code = src.slice(i + 2, end2); len = end2 + 2 - i; }
        }
        flush();
        out += `<code>${esc(code)}</code>`;
        i += len;
        continue;
      }
    }
    if (two === '~~') {
      const j = src.indexOf('~~', i + 2);
      if (j > i + 2) { flush(); out += `<del>${inline(src.slice(i + 2, j))}</del>`; i = j + 2; continue; }
    }
    if (two === '**') {
      const j = src.indexOf('**', i + 2);
      if (j > i + 2) { flush(); out += `<strong>${inline(src.slice(i + 2, j))}</strong>`; i = j + 2; continue; }
    }
    if (src.startsWith('![', i)) { if (tryBracket(true) > 0) continue; }
    if (c === '[') { if (tryBracket(false) > 0) continue; }
    if (c === '<') {
      const em = /^<([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})>/.exec(src.slice(i));
      const al = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*)>/.exec(src.slice(i));
      if (em) { flush(); out += `<a href="mailto:${esc(em[1])}">${esc(em[1])}</a>`; i += em[0].length; continue; }
      if (al) { const h = safeHref(al[1]); if (h) { flush(); out += `<a href="${esc(h)}" target="_blank" rel="noopener noreferrer">${esc(al[1])}</a>`; i += al[0].length; continue; } }
    }
    if (c === '*' || c === '_') {
      const j = src.indexOf(c, i + 1);
      if (j > i + 1) {
        const seg = src.slice(i + 1, j);
        if (!/^\s|\s$/.test(seg)) { flush(); out += `<em>${inline(seg)}</em>`; i = j + 1; continue; }
      }
    }
    pushText(c);
    i++;
  }
  flush();
  return out;
}

// 表格单元按未转义管道拆分
function splitPipe(s) {
  const cells = []; let cur = '';
  for (let j = 0; j < s.length; j++) {
    if (s[j] === '\\' && s[j + 1] === '|') { cur += '|'; j++; continue; }
    if (s[j] === '|') { cells.push(cur); cur = ''; continue; }
    cur += s[j];
  }
  cells.push(cur);
  return cells;
}
function isSepRow(s) {
  return /^\s*\|?[\s:|-]*\|[\s:|-]+\|?[\s:|-]*\s*$/.test(s) && s.includes('-');
}

const BLOCK_START = (l) => {
  if (/^(#{1,6})\s+/.test(l)) return true;
  if (/^```/.test(l.trim()) || /^~~~/.test(l.trim())) return true;
  if (/^>\s?/.test(l)) return true;
  if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(l)) return true;
  if (/^\s*(?:[-*+]|\d+\.)\s+/.test(l)) return true;
  return false;
};

export function render(md) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  let html = '', i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 空行
    if (/^\s*$/.test(line)) { i++; continue; }

    // 代码围栏
    const fm = /^```([\w+-]*)\s*$/.exec(line) || /^~~~([\w+-]*)\s*$/.exec(line);
    if (fm) {
      const lang = fm[1], fence = line.trim().slice(0, 3);
      i++;
      const buf = [];
      while (i < lines.length && !lines[i].trim().startsWith(fence)) buf.push(lines[i++]);
      i++; // 跳过闭合行（若无闭合则吞到末尾）
      // 结构保持 <pre><code class="language-x">：与 WordPress / Typecho 输出一致，文章互搬不异常
      const norm = normalizeLang(lang);
      const cls = ['hljs'];
      if (norm) cls.push('language-' + esc(norm));
      else if (lang) cls.push('language-' + esc(lang));
      html += `<pre><code class="${cls.join(' ')}">${highlight(buf.join('\n'), lang)}</code></pre>\n`;
      continue;
    }

    // ATX 标题
    const hd = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (hd) {
      const lv = hd[1].length;
      html += `<h${lv}>${inline(hd[2])}</h${lv}>\n`;
      i++;
      continue;
    }

    // 分割线
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { html += '<hr>\n'; i++; continue; }

    // 引用（逐层剥去 > 后递归）
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++; }
      html += '<blockquote>\n' + render(buf.join('\n')) + '</blockquote>\n';
      continue;
    }

    // 列表
    const lm = /^(\s*)(?:[-*+]|\d+\.)\s+/.exec(line);
    if (lm) {
      const baseInd = lm[1].length;
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items = [];
      let cur = null;
      const endItem = () => { if (cur) { items.push(cur); cur = null; } };
      while (i < lines.length) {
        const l = lines[i];
        if (/^\s*$/.test(l)) {
          const j = i + 1;
          if (j < lines.length) {
            const nl = lines[j];
            const ind2 = (nl.match(/^\s*/) || [''])[0].length;
            const isItem = /^\s*(?:[-*+]|\d+\.)\s+/.test(nl);
            if (!isItem && ind2 > baseInd) { if (cur) cur.lines.push(''); i++; continue; }
          }
          break;
        }
        const ind = (l.match(/^\s*/) || [''])[0].length;
        const mi = /^\s*(?:[-*+]|\d+\.)\s+/.exec(l);
        if (mi && ind === baseInd) {
          endItem();
          const taskM = /^\s*[-*+]\s+\[( |x|X)\]\s+/.exec(l);
          let text = l.replace(/^\s*(?:[-*+]|\d+\.)\s+/, '');
          if (taskM) text = text.replace(/^\[(?: |x|X)\]\s*/, '');
          cur = { task: taskM ? taskM[1] !== ' ' : null, lines: [text] };
          i++; continue;
        }
        if (ind < baseInd) break;
        if (cur) { cur.lines.push(ind > baseInd ? l.replace(/^\s+/, ' ') : l); i++; continue; }
        break;
      }
      endItem();
      html += ordered ? '<ol>\n' : '<ul>\n';
      for (const it of items) {
        const raw = it.lines.join('\n').replace(/\n{3,}/g, '\n\n');
        // 单行列表项直接走行内渲染，不再套 <p>：否则每项多出段落外边距，列表松散且末项拖尾
        const tight = !raw.includes('\n') && !BLOCK_START(raw);
        const inner = (tight ? inline(raw) : render(raw)).trim();
        if (it.task != null) {
          const chk = `<label><input type="checkbox" disabled${it.task ? ' checked' : ''}> ${inner}</label>`;
          html += `<li class="task">${chk}</li>\n`;
        } else {
          html += `<li>${inner}</li>\n`;
        }
      }
      html += ordered ? '</ol>\n' : '</ul>\n';
      continue;
    }

    // 表格：当前行含管道且下一行是分隔行
    if (line.includes('|') && i + 1 < lines.length && isSepRow(lines[i + 1])) {
      const sep = lines[i + 1];
      const trimEdge = (arr) => {
        const a = arr.slice();
        if (a.length > 1 && a[0] === '') a.shift();
        if (a.length > 1 && a[a.length - 1] === '') a.pop();
        return a;
      };
      const heads = trimEdge(splitPipe(line).map((c) => c.trim()));
      const alignsRaw = trimEdge(splitPipe(sep).map((c) => c.trim()));
      const aligns = alignsRaw.map((t) => {
        if (/^:.*:$/.test(t)) return 'center';
        if (/^:/.test(t)) return 'left';
        if (/:$/.test(t)) return 'right';
        return '';
      });
      i += 2;
      const rows = [];
      while (i < lines.length) {
        const l = lines[i];
        if (!l.includes('|') || BLOCK_START(l) || /^\s*$/.test(l)) break;
        rows.push(trimEdge(splitPipe(l).map((c) => c.trim())));
        i++;
      }
      const cell = (tag) => (txt, k) => `<${tag}${aligns[k] ? ` style="text-align:${aligns[k]}"` : ''}>${inline(txt)}</${tag}>`;
      const th = cell('th'), td = cell('td');
      html += '<table>\n<thead><tr>' + heads.map(th).join('') + '</tr></thead>\n<tbody>\n';
      for (const r of rows) {
        const cells = r.length < heads.length ? r.concat(new Array(heads.length - r.length).fill('')) : r;
        html += '<tr>' + cells.slice(0, heads.length).map(td).join('') + '</tr>\n';
      }
      html += '</tbody>\n</table>\n';
      continue;
    }

    // 普通段落（连续收集到空行或块级起始）
    const buf = [];
    while (i < lines.length) {
      const l = lines[i];
      if (/^\s*$/.test(l)) break;
      if (BLOCK_START(l)) break;
      if (l.includes('|') && i + 1 < lines.length && isSepRow(lines[i + 1])) break;
      buf.push(l); i++;
    }
    if (buf.length) html += `<p>${inline(buf.join('\n'))}</p>\n`;
    else i++;
  }
  return html;
}

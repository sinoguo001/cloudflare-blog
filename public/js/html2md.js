// ============================================================
// HTML → Markdown（Ver 0.7 ① 数据导入）
//
// Typecho 的正文本来就是 Markdown，直接可用；WordPress 与 Z-Blog 存的是
// HTML，而本站编辑器以 Markdown 为准 —— 不转的话后台打开是一堆标签，
// 改一下再保存就会把版式弄坏。
//
// 取向：能转的转干净，转不了的**原样留成 HTML 片段**（Markdown 允许嵌
// HTML，而我们的渲染器会把它当文本转义 —— 所以宁可降级成纯文本/链接，
// 不要留一个看着像标签但会显示成源码的东西）。
// 前台显示用的是导入时另存的原始 HTML，所以这里转得不够漂亮也不会影响
// 读者看到的页面。
// ============================================================

const VOID = new Set(['br', 'img', 'hr', 'input', 'meta', 'link', 'source', 'col', 'area', 'base', 'embed', 'param', 'track', 'wbr']);
const DROP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'canvas', 'form', 'button', 'select', 'textarea']);

const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', middot: '·', times: '×' };

export function decodeEntities(s) {
  return String(s || '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (all, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return all;
      try {
        return String.fromCodePoint(code);
      } catch (e) {
        return all;
      }
    }
    const v = ENTITY[body.toLowerCase()];
    return v === undefined ? all : v;
  });
}

function parseAttrs(raw) {
  const out = {};
  const re = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let m;
  while ((m = re.exec(raw))) {
    out[m[1].toLowerCase()] = decodeEntities(m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4]);
  }
  return out;
}

function parse(html) {
  const root = { tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<![^>]*>|<\/?([a-zA-Z][\w:-]*)([^>]*?)(\/?)>/g;
  let last = 0;
  let m;
  while ((m = re.exec(html))) {
    const text = html.slice(last, m.index);
    if (text) stack[stack.length - 1].children.push({ text });
    last = re.lastIndex;
    if (m[0][0] === '<' && (m[0][1] === '!' || m[0][1] === '?')) continue; // 注释 / doctype / WP 区块标记
    const tag = (m[1] || '').toLowerCase();
    if (!tag) continue;
    if (m[0][1] === '/') {
      for (let i = stack.length - 1; i >= 1; i--) {
        if (stack[i].tag === tag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const node = { tag, attrs: parseAttrs(m[2] || ''), children: [] };
    stack[stack.length - 1].children.push(node);
    if (!VOID.has(tag) && !m[3]) stack.push(node);
  }
  const tail = html.slice(last);
  if (tail) root.children.push({ text: tail });
  return root.children;
}

function textOf(node) {
  if (node.text !== undefined) return node.text;
  return (node.children || []).map(textOf).join('');
}

function escMd(s) {
  return String(s || '').replace(/([\\*_\[\]])/g, '\\$1');
}

function blockJoin(parts) {
  return parts.filter((p) => p !== '').join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

function indent(s, prefix) {
  return s
    .split('\n')
    .map((l) => (l ? prefix + l : prefix.trimEnd()))
    .join('\n');
}

function isBlock(node) {
  if (!node || node.text !== undefined) return false;
  return !['a', 'strong', 'b', 'em', 'i', 'del', 's', 'code', 'span', 'sup', 'sub', 'mark', 'small', 'u', 'abbr', 'font', 'label'].includes(node.tag);
}

function inline(nodes, ctx) {
  return (nodes || [])
    .map((n) => {
      if (n.text !== undefined) return escMd(decodeEntities(n.text).replace(/\s+/g, ' '));
      const tag = n.tag;
      if (DROP.has(tag)) return '';
      const inner = () => (n.children || []).map((c) => renderNode(c, ctx)).join('');
      const flat = () => inline(n.children, ctx);
      switch (tag) {
        case 'br':
          return '  \n';
        case 'strong':
        case 'b':
          return `**${flat().trim()}**`;
        case 'em':
        case 'i':
          return `*${flat().trim()}*`;
        case 'del':
        case 's':
          return `~~${flat().trim()}~~`;
        case 'code': {
          const t = textOf(n).replace(/\n/g, ' ');
          return '`' + (t.includes('`') ? t.replace(/`/g, '\\`') : t) + '`';
        }
        case 'a': {
          const href = n.attrs.href || '';
          const label = flat().trim() || href;
          if (!href || /^javascript:/i.test(href)) return label;
          return `[${label}](${href.replace(/\)/g, '%29')})`;
        }
        case 'img': {
          const src = n.attrs.src || n.attrs['data-src'] || n.attrs['data-original'] || '';
          if (!src) return '';
          return `![${(n.attrs.alt || '').replace(/[[\]]/g, '')}](${withBase(src, ctx)})`;
        }
        case 'iframe':
        case 'video':
        case 'audio': {
          const src = n.attrs.src || '';
          return src ? `[${tag === 'iframe' ? '嵌入内容' : tag}](${src})` : '';
        }
        case 'span':
        case 'sup':
        case 'sub':
        case 'mark':
        case 'small':
        case 'u':
        case 'abbr':
        case 'font':
        case 'label':
          return flat();
        default:
          return inner();
      }
    })
    .join('');
}

function withBase(src, ctx) {
  const s = String(src || '');
  if (!ctx || !ctx.base) return s;
  if (/^(?:https?:)?\/\//i.test(s) || /^data:/i.test(s)) return s;
  try {
    return new URL(s, ctx.base).toString();
  } catch (e) {
    return s;
  }
}

function renderNode(n, ctx) {
  if (n.text !== undefined) return escMd(decodeEntities(n.text));
  if (DROP.has(n.tag)) return '';
  const tag = n.tag;
  const kids = n.children || [];

  switch (tag) {
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6': {
      const lv = Number(tag[1]);
      // 正文里的 h1 会跟文章标题打架，压到 h2；h2 及以下保持原级
      const level = Math.min(6, Math.max(2, lv));
      return '#'.repeat(level) + ' ' + inline(kids, ctx).trim();
    }
    case 'p':
      return inline(kids, ctx).trim();
    case 'hr':
      return '---';
    case 'br':
      return '';
    case 'pre': {
      const code = textOf(n).replace(/\n+$/, '');
      // 语言类名常常挂在里层的 <code> 上，不在 <pre> 上
      const codeNode = (n.children || []).find((c) => c.tag === 'code');
      const cls = (n.attrs.class || '') + ' ' + (codeNode ? codeNode.attrs.class || '' : '');
      const lang = cls.match(/(?:language|lang)-([\w+-]+)/);
      return '```' + (lang ? lang[1] : '') + '\n' + code + '\n```';
    }
    case 'blockquote': {
      const body = blockJoin(kids.map((c) => renderNode(c, ctx)));
      return indent(body, '> ');
    }
    case 'ul':
    case 'ol': {
      const ordered = tag === 'ol';
      let idx = 1;
      const items = [];
      for (const c of kids) {
        if (c.text !== undefined) {
          const t = escMd(decodeEntities(c.text)).trim();
          if (t) items.push((ordered ? `${idx++}. ` : '- ') + t);
          continue;
        }
        if (c.tag !== 'li') {
          const b = renderNode(c, ctx).trim();
          if (b) items.push(b);
          continue;
        }
        const mark = ordered ? `${idx++}. ` : '- ';
        const body = blockJoin((c.children || []).map((k) => renderNode(k, ctx))).trim();
        const lines = body.split('\n');
        items.push(mark + (lines[0] || ''));
        for (const l of lines.slice(1)) items.push('  ' + l);
      }
      return items.join('\n');
    }
    case 'li':
      return '- ' + inline(kids, ctx).trim();
    case 'table': {
      const rows = [];
      const walk = (nd) => {
        for (const c of nd.children || []) {
          if (c.text !== undefined) continue;
          if (c.tag === 'tr') {
            const cells = (c.children || [])
              .filter((x) => x.tag === 'td' || x.tag === 'th')
              .map((x) => inline(x.children, ctx).replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim());
            if (cells.length) rows.push({ cells, head: (c.children || []).some((x) => x.tag === 'th') });
          } else walk(c);
        }
      };
      walk(n);
      if (!rows.length) return '';
      const width = Math.max(...rows.map((r) => r.cells.length));
      const pad = (arr) => arr.concat(Array(Math.max(0, width - arr.length)).fill(''));
      const out = [];
      out.push('| ' + pad(rows[0].cells).join(' | ') + ' |');
      out.push('| ' + Array(width).fill('---').join(' | ') + ' |');
      for (const r of rows.slice(1)) out.push('| ' + pad(r.cells).join(' | ') + ' |');
      return out.join('\n');
    }
    case 'figure': {
      const body = blockJoin(kids.map((c) => renderNode(c, ctx)));
      return body;
    }
    case 'figcaption':
      return inline(kids, ctx).trim() ? '*' + inline(kids, ctx).trim() + '*' : '';
    case 'div':
    case 'section':
    case 'article':
    case 'main':
    case 'header':
    case 'footer':
    case 'aside':
    case 'nav':
    case 'dl':
    case 'dd':
    case 'dt':
    case 'center': {
      const blocks = kids.map((c) => renderNode(c, ctx)).filter((x) => x.trim() !== '');
      return blockJoin(blocks);
    }
    default: {
      if (isBlock(n)) return blockJoin(kids.map((c) => renderNode(c, ctx)));
      return inline(kids, ctx);
    }
  }
}

export function htmlToMarkdown(html, opts = {}) {
  const src = String(html == null ? '' : html);
  if (!src.trim()) return '';
  const ctx = { base: opts.base || '' };
  const nodes = parse(src);
  const out = blockJoin(nodes.map((n) => renderNode(n, ctx)));
  return out
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 从 HTML 里摘一段纯文本（做摘要用）
export function htmlToText(html, max = 0) {
  const nodes = parse(String(html || ''));
  const txt = nodes
    .map((n) => textOf(n))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return max > 0 && txt.length > max ? txt.slice(0, max) + '…' : txt;
}

// Typecho 的 Markdown 正文会带这个前缀；有的导出器还会留 <!--more-->
export function cleanMarkdown(md) {
  return String(md || '')
    .replace(/^\s*<!--\s*markdown\s*-->/i, '')
    .replace(/<!--\s*more\s*-->/gi, '')
    .replace(/\r\n/g, '\n')
    .trim();
}

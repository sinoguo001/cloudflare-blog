// ============================================================
// 轻量语法高亮（Worker 端，零外部依赖）
//
// 设计要点：
//  1) 输出结构：`<pre><code class="language-x">…</code></pre>`
//     —— 与 WordPress / Typecho / 各 Markdown 编辑器完全一致，文章互相搬运不会异常。
//  2) 着色标签使用 highlight.js 的标准类名（hljs-keyword / hljs-string …），
//     因此任何 hljs 主题 CSS（含 WP/Typecho 常用主题）都能直接套用。
//  3) 全程服务端渲染：不依赖任何 CDN，国内访问无加载失败风险，爬虫也能读到着色后的正文。
// ============================================================

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

// ---- 类名常量（与 highlight.js 保持一致）----
const C = {
  comment: 'hljs-comment',
  quote: 'hljs-quote',
  string: 'hljs-string',
  number: 'hljs-number',
  keyword: 'hljs-keyword',
  literal: 'hljs-literal',
  builtin: 'hljs-built_in',
  title: 'hljs-title',
  func: 'hljs-title function_',
  meta: 'hljs-meta',
  attr: 'hljs-attr',
  attribute: 'hljs-attribute',
  tag: 'hljs-tag',
  name: 'hljs-name',
  type: 'hljs-type',
  variable: 'hljs-variable',
  symbol: 'hljs-symbol',
  bullet: 'hljs-bullet',
  section: 'hljs-section',
  addition: 'hljs-addition',
  deletion: 'hljs-deletion',
  regexp: 'hljs-regexp',
  selectorTag: 'hljs-selector-tag',
};

// ---- 关键字表 ----
const K = {
  javascript: 'const let var function return if else for while do break continue new class extends super this typeof instanceof in of try catch finally throw switch case default delete void yield await async import export from as static get set instanceof debugger with',
  typescript: 'const let var function return if else for while do break continue new class extends super this typeof instanceof in of try catch finally throw switch case default delete void yield await async import export from as static get set interface type enum implements declare namespace public private protected readonly abstract keyof infer satisfies',
  java: 'public private protected class interface extends implements abstract final static void new return if else for while do break continue switch case default try catch finally throw throws import package this super instanceof enum record sealed native synchronized volatile transient assert',
  c: 'if else for while do break continue switch case default return goto sizeof typedef struct union enum static const volatile extern register signed unsigned void int char float double long short auto restrict inline _Bool',
  cpp: 'if else for while do break continue switch case default return goto sizeof typedef struct union enum static const volatile extern register signed unsigned void int char float double long short auto inline namespace template typename class public private protected virtual override final friend using new delete this operator noexcept constexpr decltype static_cast const_cast reinterpret_cast dynamic_cast',
  csharp: 'public private protected internal class interface struct enum namespace using static readonly const void new return if else for foreach while do break continue switch case default try catch finally throw this base abstract virtual override sealed partial var async await get set delegate event in out ref params is as typeof sizeof nameof',
  go: 'package import func return if else for range go defer chan select switch case default break continue fallthrough var const type struct interface map make new len cap append copy delete panic recover nil true false string int int64 float64 bool byte rune error',
  rust: 'fn let mut const static struct enum impl trait for in while loop match if else return break continue use mod pub crate super self Self where as ref move box unsafe dyn type unsafe async await',
  php: 'function return if else elseif for foreach while do break continue switch case default echo print new class extends implements public private protected static const var use namespace require include as try catch finally throw global array isset unset empty list instanceof abstract final interface trait yield fn match',
  kotlin: 'fun val var class interface object when if else for while do break continue return package import is in as this super companion data sealed open override private public internal suspend lateinit by',
  swift: 'func var let class struct enum protocol extension import return if else for in while repeat guard switch case default break continue self init deinit private public internal fileprivate open static override throws rethrows try catch do defer as is nil true false',
  python: 'def class return if elif else for while break continue pass import from as with try except finally raise yield lambda global nonlocal assert del in is not and or None True False async await self print',
  bash: 'if then else elif fi for while until do done case esac function return in select time coproc local export readonly declare unset shift exit trap set source echo cd ls rm cp mv mkdir touch cat grep sed awk find sudo apt yum npm git curl wget make chmod chown kill ps df du tar ssh scp',
  sql: 'SELECT FROM WHERE INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE DROP ALTER ADD COLUMN PRIMARY KEY FOREIGN REFERENCES INDEX VIEW AS JOIN LEFT RIGHT INNER OUTER FULL ON GROUP BY ORDER HAVING LIMIT OFFSET DISTINCT UNION ALL CASE WHEN THEN ELSE END AND OR NOT NULL IS IN EXISTS BETWEEN LIKE COUNT SUM AVG MIN MAX CAST COALESCE WITH RECURSIVE',
};

const LIT = {
  javascript: 'true false null undefined NaN Infinity',
  typescript: 'true false null undefined NaN Infinity any unknown never string number boolean object symbol bigint',
  java: 'true false null',
  c: 'true false NULL',
  cpp: 'true false nullptr NULL',
  csharp: 'true false null',
  go: 'true false nil iota',
  rust: 'true false None Some Ok Err',
  php: 'true false null TRUE FALSE NULL',
  kotlin: 'true false null',
  swift: 'true false nil',
  python: 'True False None self',
  sql: 'NULL TRUE FALSE',
};

const BUILTIN = {
  javascript: 'console Math JSON Object Array String Number Boolean Promise Date RegExp Map Set Symbol Error window document globalThis require module exports process setTimeout setInterval fetch',
  typescript: 'console Math JSON Object Array String Number Boolean Promise Date RegExp Map Set Symbol Error window document globalThis require module exports process',
  python: 'print len range str int float list dict set tuple open type isinstance enumerate zip map filter sum min max sorted abs round input super Exception ValueError TypeError KeyError',
  php: 'echo print count strlen array_map array_filter isset unset empty json_encode json_decode PDO mysqli',
  go: 'fmt os io errors strings strconv time sort sync context http json log',
  java: 'System String Integer Double Boolean List ArrayList Map HashMap Set HashSet Arrays Collections Optional Stream',
};

function words(s) { return (s || '').split(/\s+/).filter(Boolean); }
function alt(list) { return list.sort((a, b) => b.length - a.length).join('|'); }

// 通用正则片段（注意：全部使用非捕获组，便于合并成主正则）
const RE = {
  blockComment: /\/\*[\s\S]*?\*\//,
  cLineComment: /\/\/[^\n]*/,
  hashComment: /#[^\n]*/,
  dashComment: /--[^\n]*/,
  strDQ: /"(?:\\.|[^"\\\n])*"?/,
  strSQ: /'(?:\\.|[^'\\\n])*'?/,
  strTpl: /`(?:\\.|[^`\\])*`?/,
  pyStr: /"""[\s\S]*?"""|'''[\s\S]*?'''/,
  number: /\b0[xX][0-9a-fA-F_]+\b|\b\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?\b/,
  funcCall: /\b[A-Za-z_$][\w$]*(?=\s*\()/,
  decorator: /^\s*@[\w.]+/m,
  phpVar: /\$[\w]+/,
  shellVar: /\$\{?[\w]+\}?/,
  label: /^\s*[+-][^\n]*/m,
};

function cStyle(lang, extra = {}) {
  const r = [];
  r.push({ c: C.comment, r: RE.blockComment.source });
  r.push({ c: C.comment, r: RE.cLineComment.source });
  if (extra.hash) r.push({ c: C.comment, r: RE.hashComment.source });
  r.push({ c: C.string, r: [RE.strDQ.source, RE.strSQ.source, extra.tpl ? RE.strTpl.source : null].filter(Boolean).join('|') });
  if (extra.phpVar) r.push({ c: C.variable, r: RE.phpVar.source });
  if (extra.decorator) r.push({ c: C.meta, r: RE.decorator.source });
  r.push({ c: C.number, r: RE.number.source });
  r.push({ c: C.func, r: RE.funcCall.source });
  if (words(K[lang]).length) r.push({ c: C.keyword, r: '\\b(?:' + alt(words(K[lang])) + ')\\b' });
  if (words(LIT[lang]).length) r.push({ c: C.literal, r: '\\b(?:' + alt(words(LIT[lang])) + ')\\b' });
  if (words(BUILTIN[lang]).length) r.push({ c: C.builtin, r: '\\b(?:' + alt(words(BUILTIN[lang])) + ')\\b' });
  return r;
}

// 各语言规则表
function rulesFor(id) {
  switch (id) {
    case 'javascript': case 'jsx': return cStyle('javascript', { tpl: true });
    case 'typescript': case 'tsx': return cStyle('typescript', { tpl: true });
    case 'java': return cStyle('java', { decorator: true });
    case 'c': return cStyle('c');
    case 'cpp': case 'c++': return cStyle('cpp');
    case 'csharp': case 'c#': return cStyle('csharp');
    case 'go': case 'golang': return cStyle('go');
    case 'rust': return cStyle('rust');
    case 'kotlin': return cStyle('kotlin');
    case 'swift': return cStyle('swift');
    case 'php': return cStyle('php', { hash: true, phpVar: true });
    case 'python': case 'py': return [
      { c: C.string, r: RE.pyStr.source },
      { c: C.comment, r: RE.hashComment.source },
      { c: C.meta, r: RE.decorator.source },
      { c: C.string, r: 'f?' + RE.strDQ.source + '|f?' + RE.strSQ.source },
      { c: C.number, r: RE.number.source },
      { c: C.func, r: RE.funcCall.source },
      { c: C.keyword, r: '\\b(?:' + alt(words(K.python)) + ')\\b' },
      { c: C.literal, r: '\\b(?:' + alt(words(LIT.python)) + ')\\b' },
      { c: C.builtin, r: '\\b(?:' + alt(words(BUILTIN.python)) + ')\\b' },
    ];
    case 'bash': case 'shell': case 'sh': case 'zsh': case 'console': return [
      { c: C.comment, r: RE.hashComment.source },
      { c: C.string, r: RE.strDQ.source + '|' + RE.strSQ.source },
      { c: C.variable, r: RE.shellVar.source },
      { c: C.number, r: RE.number.source },
      { c: C.keyword, r: '\\b(?:' + alt(words(K.bash)) + ')\\b' },
    ];
    case 'sql': return [
      { c: C.comment, r: RE.dashComment.source },
      { c: C.comment, r: RE.blockComment.source },
      { c: C.string, r: RE.strSQ.source + '|' + RE.strDQ.source },
      { c: C.number, r: RE.number.source },
      { c: C.keyword, r: '\\b(?:' + alt(words(K.sql)) + ')\\b' },
    ];
    case 'json': return [
      { c: C.attr, r: '"(?:\\.|[^"\\])*"(?=\s*:)' },
      { c: C.string, r: '"(?:\\.|[^"\\])*"' },
      { c: C.number, r: RE.number.source },
      { c: C.literal, r: '\\b(?:true|false|null)\\b' },
    ];
    case 'yaml': case 'yml': return [
      { c: C.comment, r: RE.hashComment.source },
      { c: C.attr, r: /^[\t ]*[\w.\-]+(?=\s*:)/m.source },
      { c: C.string, r: RE.strDQ.source + '|' + RE.strSQ.source },
      { c: C.number, r: RE.number.source },
      { c: C.literal, r: '\\b(?:true|false|null|yes|no|on|off)\\b' },
      { c: C.bullet, r: /^[\t ]*-[ \t]/.source.replace('[ \\t]', '(?=[ \\t])') },
    ];
    case 'html': case 'xml': case 'vue': case 'svg': return [
      { c: C.comment, r: /<!--[\s\S]*?-->/.source },
      { c: C.tag, r: /<\/?[A-Za-z][\w:\-]*/.source },
      { c: C.name, r: /[A-Za-z_:][\w:\-.]*(?=\s*=)/.source },
      { c: C.string, r: RE.strDQ.source + '|' + RE.strSQ.source },
      { c: C.tag, r: /\/?>/.source },
    ];
    case 'css': case 'scss': case 'less': return [
      { c: C.comment, r: RE.blockComment.source },
      { c: C.attr, r: /[\w-]+(?=\s*:)/.source },
      { c: C.string, r: RE.strDQ.source + '|' + RE.strSQ.source },
      { c: C.number, r: /-?\d*\.?\d+(?:px|em|rem|%|vh|vw|s|ms|deg|fr|ch)?\b/.source },
      { c: C.keyword, r: /#[0-9a-fA-F]{3,8}\b|!important\b/.source },
      { c: C.selectorTag, r: /[.#][\w-]+|\b[a-z]+(?=\s*\{)/.source },
    ];
    case 'diff': case 'patch': return [
      { c: C.meta, r: /^@@[^\n]*/m.source },
      { c: C.addition, r: /^\+[^\n]*/m.source },
      { c: C.deletion, r: /^-[^\n]*/m.source },
    ];
    case 'ini': case 'toml': case 'conf': return [
      { c: C.comment, r: /;[^\n]*/.source + '|' + RE.hashComment.source },
      { c: C.section, r: /^\[[^\]\n]*\]/m.source },
      { c: C.attr, r: /^[\t ]*[\w.\-]+(?=\s*=)/m.source },
      { c: C.string, r: RE.strDQ.source + '|' + RE.strSQ.source },
      { c: C.number, r: RE.number.source },
      { c: C.literal, r: '\\b(?:true|false)\\b' },
    ];
    case 'markdown': case 'md': return [
      { c: C.section, r: /^#{1,6}[^\n]*/m.source },
      { c: C.string, r: RE.strTpl.source },
      { c: C.bullet, r: /^[\t ]*[-*+](?=\s)/m.source },
      { c: C.quote, r: /^>[^\n]*/m.source },
    ];
    default: return null;
  }
}

// 语言别名归一（含 WordPress / Typecho 里常见的写法）
const ALIAS = {
  js: 'javascript', jsx: 'javascript', node: 'javascript', javascript: 'javascript',
  ts: 'typescript', typescript: 'typescript',
  py: 'python', python: 'python', python3: 'python',
  sh: 'bash', shell: 'bash', bash: 'bash', zsh: 'bash', console: 'bash',
  html: 'html', htm: 'html', xml: 'html', vue: 'html', svg: 'html',
  css: 'css', scss: 'css', less: 'css',
  json: 'json', jsonc: 'json',
  yml: 'yaml', yaml: 'yaml',
  c: 'c', h: 'c', cpp: 'cpp', 'c++': 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
  cs: 'csharp', 'c#': 'csharp', csharp: 'csharp',
  java: 'java', kt: 'kotlin', kotlin: 'kotlin', swift: 'swift',
  go: 'go', golang: 'go', rs: 'rust', rust: 'rust', php: 'php',
  sql: 'sql', mysql: 'sql', pgsql: 'sql',
  ini: 'ini', toml: 'ini', conf: 'ini', cfg: 'ini',
  md: 'markdown', markdown: 'markdown',
  diff: 'diff', patch: 'diff',
  text: 'plain', txt: 'plain', plain: 'plain', plaintext: 'plain',
};

// 主分词：所有规则合并为一个正则（每条规则占一个捕获组，凭组号判定配色）
function tokenize(code, rules) {
  const src = rules.map((r) => '(' + r.r + ')').join('|');
  let re;
  try { re = new RegExp(src, 'gm'); } catch (e) { return esc(code); }
  let out = '', last = 0, m, guard = 0;
  while ((m = re.exec(code)) !== null) {
    if (guard++ > 20000) break;               // 防御性上限，避免异常输入卡死
    if (m[0] === '') { re.lastIndex++; continue; }
    let cls = null;
    for (let i = 1; i < m.length; i++) { if (m[i] !== undefined) { cls = rules[i - 1].c; break; } }
    out += esc(code.slice(last, m.index));
    out += cls ? `<span class="${cls}">${esc(m[0])}</span>` : esc(m[0]);
    last = m.index + m[0].length;
  }
  out += esc(code.slice(last));
  return out;
}

export function highlight(code, lang) {
  const src = String(code ?? '');
  const key = ALIAS[String(lang || '').toLowerCase().trim()] || '';
  if (!key || key === 'plain') return esc(src);
  const rules = rulesFor(key);
  if (!rules) return esc(src);
  return tokenize(src, rules);
}

export function normalizeLang(lang) {
  const key = ALIAS[String(lang || '').toLowerCase().trim()];
  return key || '';
}

export const SUPPORTED_LANGS = [
  'plain', 'javascript', 'typescript', 'python', 'bash', 'html', 'css', 'json',
  'yaml', 'sql', 'java', 'c', 'cpp', 'csharp', 'go', 'rust', 'kotlin', 'swift',
  'php', 'markdown', 'diff', 'ini',
];

// ---- 配色主题（后台可切换；默认 github，与 WordPress / Typecho 默认观感一致）----
const THEMES = {
  github: { bg: '#f6f8fa', fg: '#24292e', comment: '#6a737d', keyword: '#d73a49', string: '#032f62', number: '#005cc5', func: '#6f42c1', builtin: '#005cc5', meta: '#6a737d', tag: '#22863a', attr: '#6f42c1', name: '#22863a', type: '#e36209', variable: '#e36209', section: '#005cc5', bullet: '#735c0f', add: '#22863a', del: '#b31d28' },
  'github-dark': { bg: '#161b22', fg: '#e6edf3', comment: '#8b949e', keyword: '#ff7b72', string: '#a5d6ff', number: '#79c0ff', func: '#d2a8ff', builtin: '#79c0ff', meta: '#8b949e', tag: '#7ee787', attr: '#d2a8ff', name: '#7ee787', type: '#ffa657', variable: '#ffa657', section: '#79c0ff', bullet: '#f2cc60', add: '#7ee787', del: '#ffa198' },
  monokai: { bg: '#272822', fg: '#f8f8f2', comment: '#75715e', keyword: '#f92672', string: '#e6db74', number: '#ae81ff', func: '#a6e22e', builtin: '#66d9ef', meta: '#75715e', tag: '#f92672', attr: '#a6e22e', name: '#f92672', type: '#66d9ef', variable: '#fd971f', section: '#a6e22e', bullet: '#ae81ff', add: '#a6e22e', del: '#f92672' },
  'atom-one-dark': { bg: '#282c34', fg: '#abb2bf', comment: '#5c6370', keyword: '#c678dd', string: '#98c379', number: '#d19a66', func: '#61afef', builtin: '#56b6c2', meta: '#5c6370', tag: '#e06c75', attr: '#d19a66', name: '#e06c75', type: '#e5c07b', variable: '#e06c75', section: '#61afef', bullet: '#c678dd', add: '#98c379', del: '#e06c75' },
  'atom-one-light': { bg: '#fafafa', fg: '#383a42', comment: '#a0a1a7', keyword: '#a626a4', string: '#50a14f', number: '#986801', func: '#4078f2', builtin: '#0184bc', meta: '#a0a1a7', tag: '#e45649', attr: '#986801', name: '#e45649', type: '#c18401', variable: '#e45649', section: '#4078f2', bullet: '#a626a4', add: '#50a14f', del: '#e45649' },
  xcode: { bg: '#f6f6f6', fg: '#3d3d3d', comment: '#007400', keyword: '#ad3da4', string: '#c41a16', number: '#1c00cf', func: '#4b21b0', builtin: '#5b269a', meta: '#643820', tag: '#3f6d7a', attr: '#4b21b0', name: '#3f6d7a', type: '#5b269a', variable: '#4b21b0', section: '#4b21b0', bullet: '#3d3d3d', add: '#007400', del: '#c41a16' },
  vs2015: { bg: '#1e1e1e', fg: '#dcdcdc', comment: '#6a9955', keyword: '#569cd6', string: '#ce9178', number: '#b5cea8', func: '#dcdcaa', builtin: '#4ec9b0', meta: '#9b9b9b', tag: '#569cd6', attr: '#9cdcfe', name: '#569cd6', type: '#4ec9b0', variable: '#9cdcfe', section: '#dcdcaa', bullet: '#569cd6', add: '#6a9955', del: '#ce9178' },
};

export const CODE_THEMES = Object.keys(THEMES).map((k) => ({
  id: k, name: { github: 'GitHub 浅色（默认）', 'github-dark': 'GitHub 深色', monokai: 'Monokai 深色', 'atom-one-dark': 'Atom One Dark', 'atom-one-light': 'Atom One Light', xcode: 'Xcode 浅色', vs2015: 'Visual Studio 深色' }[k] || k,
}));

// 生成某主题的 hljs 着色 CSS
export function codeThemeCss(name) {
  const t = THEMES[name] || THEMES.github;
  return `pre code.hljs{background:${t.bg};color:${t.fg}}
.hljs-comment,.hljs-quote{color:${t.comment};font-style:italic}
.hljs-keyword,.hljs-selector-tag,.hljs-literal,.hljs-doctag{color:${t.keyword}}
.hljs-string,.hljs-regexp{color:${t.string}}
.hljs-number,.hljs-symbol,.hljs-bullet,.hljs-link{color:${t.number}}
.hljs-title,.hljs-title.function_,.hljs-section{color:${t.func}}
.hljs-built_in,.hljs-class .hljs-title,.hljs-type{color:${t.builtin}}
.hljs-meta,.hljs-meta .hljs-keyword{color:${t.meta}}
.hljs-tag,.hljs-name,.hljs-selector-id,.hljs-selector-class{color:${t.tag}}
.hljs-attr,.hljs-attribute,.hljs-variable,.hljs-template-variable{color:${t.attr}}
.hljs-deletion{color:${t.del}}
.hljs-emphasis{font-style:italic}
.hljs-strong{font-weight:700}`;
}

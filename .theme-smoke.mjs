// 主题系统冒烟：验证 THEME_VARS 注入、themeLink 输出与编辑器预览联动
import { themeLink, render404, previewDoc } from './functions/_lib/site.js';

let pass = 0, fail = 0;
const t = (name, cond) => {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name); }
};

const sNone = new Map();
const sTheme = new Map([['site_title', 'T'], ['active_theme', 'ocean-blue'], ['accent', '#0e7d8c']]);

t('无主题时不输出外链', themeLink(sNone) === '');
t('激活 ocean-blue 时输出 style.css 外链', themeLink(sTheme).includes('/theme-assets/ocean-blue/style.css'));
t('default 关键字视为内置主题', themeLink(new Map([['active_theme', 'default']])) === '');

const home = render404(); // layout 内部，无激活主题
t('layout 注入变量表', home.includes('--font-code:Consolas') && home.includes('--accent-soft'));
t('layout 无主题外链', !home.includes('theme-assets'));

const pv = previewDoc(sTheme, { title: '样张', content_html: '<p>正文</p>' }, 'https://demo.example.com');
t('预览文档注入变量表', pv.includes('--font-body'));
t('预览文档带激活主题外链', pv.includes('https://demo.example.com/theme-assets/ocean-blue/style.css'));

console.log(fail ? 'SMOKE FAIL ' + fail : 'SMOKE PASS all=' + pass);
process.exit(fail ? 1 : 0);

// 从 public/admin/index.html 重新生成 functions/_lib/admin-shell.js
// 用法：node .gen-admin-shell.mjs   （改过 index.html 后必须重跑并提交两个文件）
import { readFileSync, writeFileSync } from 'fs';

const html = readFileSync('public/admin/index.html', 'utf8');
// 转义为 JS 模板字符串安全内容（防反引号 / ${ 破坏模板）
const s = html.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
const out =
  '// 自动生成：后台入口 HTML（由 public/admin/index.html 生成，勿手改）\n' +
  '// 修改 index.html 后运行：node .gen-admin-shell.mjs 重新生成并提交两个文件。\n' +
  'export const ADMIN_SHELL = `' + s + '`;\n';
writeFileSync('functions/_lib/admin-shell.js', out, 'utf8');
console.log('regenerated functions/_lib/admin-shell.js (' + out.length + ' bytes)');

// Markdown 渲染器冒烟测试
import { render } from 'file:///C:/Users/Wei/WorkBuddy/2026-09-07-08-23-16/cloudflare-blog/functions/_lib/md.js';
import { rfc822, slugify, escLike, paginate } from 'file:///C:/Users/Wei/WorkBuddy/2026-09-07-08-23-16/cloudflare-blog/functions/_lib/util.js';

const md = `# 一级标题

这是**加粗**、*斜体*、~~删除~~、\`行内代码\`和[链接](https://example.com?a=1&b=2)以及![图片](/media/x-1.png)的测试。

> 引用一段话
> 引用第二行

1. 有序第一
2. 有序第二

- 无序甲
- 无序乙
- [x] 已完成任务
- [ ] 待办任务

\`\`\`js
const a = "<script>alert(1)</script>";
\`\`\`

| 名称 | 数量 | 备注 |
|:---- |:----:| ----:|
| 苹果 | 3 | 好吃 |
| 香蕉 | 5 | 一般 |

---

特殊转义 \\*星号\\* 与普通文本。

<script>alert('xss')</script>
[恶意](javascript:alert(1))
<img src=x onerror=alert(1)>
`;

const out = render(md);
console.log(out);

// XSS 必须全部被转义为文本
const checks = [
  ['加粗', out.includes('<strong>加粗</strong>')],
  ['斜体', out.includes('<em>斜体</em>')],
  ['删除线', out.includes('<del>删除</del>')],
  ['行内码', out.includes('<code>行内代码</code>')],
  ['链接+&转义', out.includes('https://example.com?a=1&amp;b=2')],
  ['图片', out.includes('<img src="/media/x-1.png" alt="图片" loading="lazy">')],
  ['引用', out.includes('<blockquote>')],
  ['有序列表', out.includes('<ol>') && out.includes('有序第一')],
  ['任务列表勾选', out.includes('checked')],
  ['任务文本无残留标记', !out.includes('[x]') && !out.includes('[ ]')],
  // js 是 javascript 的别名，渲染时会规范化成 language-javascript
  ['代码围栏js', out.includes('language-javascript') && out.includes('&lt;script&gt;')],
  ['表格', out.includes('<table>') && out.includes('苹果')],
  ['分割线', out.includes('<hr>')],
  ['转义星号', out.includes('*星号*')],
  ['script 标签被转义', out.includes('&lt;script&gt;') && !out.includes('<script>alert')],
  ['javascript: 链接被拒绝', !out.includes('href="javascript:')],
  ['img 事件仅以文本呈现', out.includes('onerror') === false ? true : !/<img[^>]*onerror/i.test(out)],
];
let fail = 0;
for (const [name, ok] of checks) {
  console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name);
  if (!ok) fail++;
}
console.log('--- util ---');
console.log('rfc822:', rfc822('2026-09-07 08:23:00'));
console.log('slugify:', slugify('  特种设备 Blog 2026!  '));
console.log('escLike:', escLike('50%_off\\'));
console.log('paginate:', JSON.stringify(paginate(0, 8, 25)));
process.exit(fail ? 1 : 0);

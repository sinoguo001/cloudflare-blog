# ☁️ 云尚博客（Cloudflare 免费套餐 · 零成本全栈）

一个「打开浏览器就能写、点一下就能发」的博客系统，**前端、API、数据库、图片与备份全部跑在 Cloudflare 免费套餐上**，除部署当天的几条初始化命令外，日常写作、评论审核、图片上传、备份恢复**全程在浏览器后台完成**，不需要本地安装软件、不需要手动传文件、不需要维护服务器。

| 组件 | 用途 | 免费额度（官方现行） |
|---|---|---|
| **Pages** | 托管后台管理页面（静态应用） | 无限静态托管 |
| **Workers（Pages Functions）** | 运行 API + 博客前台实时渲染 | 10 万次请求/天（与 Workers 共享） |
| **D1** | 文章 / 分类 / 标签 / 评论 / 设置 | 5 GB 存储、每日百万级读 |
| **R2** | 图片（`media/`）+ 备份（`backups/`） | 10 GB 存储、百万次写操作/月 |

个人博客一天几十到几百次访问，用不满免费额度的零头。

---

## 📌 更新日志

### Ver 0.2（最新）

0.2 版本进行了以下修复和优化：

1. **列表序号与换行丢失** — 编辑器序列化遇到 `div` 只按 `<br>` 分段，把列表压成一整段；改为递归展开内嵌块级元素并强制块间空行，顺带修好被 `div` 包裹的表格/代码块/引用（旧文章需重新保存一次才恢复）
2. **每次编辑文章链接就变长** — 分配别名时没排除自己，`post-2` 逐次变成 `post-2-2`；改为编辑自身时别名不变。另加 `public/_headers` 让后台脚本 `no-cache`，部署后不必手动强刷
3. **RSS / 站点地图美化** — 浏览器打开由服务端直接输出排版好的 HTML 页，订阅器与搜索引擎仍拿标准 XML，按请求特征自动判别，也可加 `?format=xml` 强制
4. **导航栏「分类」「标签」点进去是 404** — 这两个页面此前不存在，且 404 页没拿到站点设置；现补齐总览页（含文章数、导航高亮），404 页也正常显示站名与图标
5. **自定义站点图标** — 新增动态 `/favicon.svg`（与页头同字同色，改站名/主题色自动跟随）；后台可分别上传 Logo 与 Favicon（留空则 Favicon 沿用 Logo），支持预览与清除，安装界面同步显示品牌标识
6. **归档等栏目误报空态** — 有文章时仍显示「还没有发布文章」：判空只看列表字段，而归档内容在另一个字段；改为两者都为空才提示，并修掉分类/标签页同类隐患
7. **首页显示优化** — 列表上方大标题原先重复显示副标题，改为「最新文章」并缩到 20px；摘要由 2 行放宽到 4 行（兜底截取 180 → 260 字），分类 / 标签 / 搜索页一并生效
8. **后台新增仪表盘** — 设为后台首页：四张总览卡（文章/评论/访问量/总字数）＋小指标＋待审评论告警（可直接通过/删除）＋最近文章、热门 TOP 5、最新评论。访问量改为**整站 PV / UV** 统计（此前只算文章页），前台上报、按天聚合，内置六道防刷过滤、命中即不写库。品牌字同步改「云」
9. **后台设置页分标签** — 改为**基本**（站点信息 / 图标 / 订阅）、**文章**（代码高亮）、**评论**（评论设置 / 头像）、**安全**（修改登录密码）四个标签页；切换不销毁 DOM，地址同步 `#/settings/xxx`，刷新仍停在原标签
10. **友情链接** — 前台「友链」页展示已通过链接并可在线申请（蜜罐 + 验证码 + 频控防刷）；后台可**通过、拒绝、编辑、删除**并填排序号，有新申请时仪表盘橙色提醒。数据已并入备份与恢复
11. **分类自定义别名** — 新建 / 编辑分类可自填别名并实时预览地址；只放行字母、数字与 `-`，重名自动追加 `-2`。顺带修了编辑时查重没排除自己、别名被不断追加序号的 bug。⚠️ 改别名后旧地址会失效，建议配 301
12. **R2 备份可删除** — 每条备份的操作列在**下载、恢复**之后加「删除」，二次确认后同步从 R2 移除；文件名严格校验防路径穿越。另修了同一秒备份互相覆盖的问题（文件名加随机后缀）

<details>
<summary><b>Ver 0.1（旧版记录，点击展开）</b></summary>

0.1 版本进行了以下修复和优化：

1. **发布后无法跳转** — 后台发布提示"接口不存在"，改用后端实际存在的 `GET /api/posts/:id`
2. **前台正文不缩进** — 段落间补空行、段内换行输出 `<br>`，正文 CSS 首行缩进 2 字符
3. **评论缺网址字段** — 新增选填「网址」（D1 加 `website` 列），填写后昵称显示为链接
4. **编辑器按钮点了没反应** — 按钮标识与分支名不匹配（`img`≠`image`、`codeblock`≠`codeBlock`），补齐别名并改站内弹窗
5. **备份列表报"接口不存在"** — 前后端路径单复数不一致（`/api/backups` vs `/api/backup`），前端改回单数、后端加别名兼容
6. **Gravatar 头像** — 评论支持全球通用头像：邮箱由选填改**必填**（仅存 MD5，不公开原文），内置 5 个头像源（默认国内可达的镜像），取不到时回落昵称首字
7. **代码高亮** — 自研零依赖高亮器，支持 21 种语言、7 套配色（默认 GitHub 浅色），兼容 WordPress / Typecho 在代码围栏后标注语言名的写法，编辑器新增高亮代码按钮
8. **留言验证码** — 「几加几等于几」算术验证码，SVG 随机旋转 + 乱序 + 诱饵字符 + 噪点曲线防 OCR；答案 HMAC 签名存 HttpOnly Cookie（30 分钟、一次性），后台「设置」可开关
9. **图片自动转 WebP** — 上传 PNG / JPG / BMP 时在**浏览器端** canvas 转 WebP（画质 0.85）再传 R2，实测省 60%~95% 体积且保留透明通道；GIF / AVIF 不动，转码失败自动回退原图

</details>

> 历史版本的完整记录见 **[CHANGELOG.md](CHANGELOG.md)**。README 默认只展开最新版本（旧版本折叠在此处），以后每版往 CHANGELOG 顶部追加，README 长度不再随版本数增长。

---

## ✨ 功能一览

**写作与发布**
- 登录后进入**仪表盘**：文章数、评论数、网站访问量（PV / UV）、博客总字数一屏总览；待审核评论置顶提示并可直接通过 / 转垃圾 / 删除；同页还有最近文章、热门 TOP 5、最新评论与快捷入口
- 所见即所得编辑器（标题/加粗/斜体/引用/列表/行内码/代码块/链接/表格/分割线/图片/清除格式）
- 文章底层存 **Markdown**；点「发布」→ 服务端 Markdown 渲染成网页，**即时生效**：首页列表、文章页、分类页、标签页、归档页、RSS、站点地图全部自动同步，无需重新构建
- 草稿 / 发布 / 下线随时切换；首次发布时间自动保留
- 编辑器内实时预览（与服务端渲染同款样式）；Ctrl+S 快捷存草稿；关页前未保存提醒

**前台（读者看到的博客）**
- 响应式首页、分类 / 标签独立页、按月归档、站内搜索、阅读量、上一篇 / 下一篇
- `https://你的域名/rss.xml`（RSS 2.0）与 `/sitemap.xml`、`/robots.txt` 自动生成；浏览器直接打开这两个 XML 会看到排版好的页面，订阅器与搜索引擎拿到的仍是标准 XML
- **站点图标可自定义**：「设置 → 站点图标」分别上传 Logo 与 Favicon（留空则 Favicon 沿用 Logo）；未设置时用**站点名首字 + 主题色**自动生成，改站名或主题色图标自动跟随
- 中文标题自动分配稳定别名（如 `/post/post-12`），也可自定英文别名
- **友情链接**：前台导航「友链」页展示已通过的链接卡片，读者可在线提交申请（蜜罐 + 验证码 + 频控防刷）；后台「友链」页审核通过 / 拒绝 / 编辑 / 排序，有新申请时仪表盘橙色提醒
- 分类支持自定义**别名**（slug），新建 / 编辑时实时预览地址；改别名后旧地址会失效，建议配 301
- **页脚不暴露后台入口**（安全考虑）；后台「设置」可填 **ICP 备案号**——填写后显示在页脚并链接工信部官网（`beian.miit.gov.cn`），留空则不显示

**评论（内置，无需 Disqus / Waline）**
- 读者发表评论（昵称、邮箱必填，网址选填），邮箱用于取 **Gravatar 全球通用头像**（只存 MD5 哈希，不公开邮箱原文）
- 内置**算术验证码**（SVG 图形干扰，后台可关）+ 蜜罐字段 + 同 IP 频率限制，三重防垃圾
- 后台「评论」页：待审核/已通过/回收站分桶，可**通过、转待审、移垃圾、彻底删除、博主回复**
- 可关闭评论、可切换“先审后发”

**媒体（R2）**
- 编辑器 🖼 按钮或图片库页上传 → 白名单 PNG/JPG/GIF/WebP/AVIF/BMP，单张 ≤ 8 MB
- **PNG / JPG / BMP 上传前在浏览器端自动转 WebP**（省 60%~95% 体积，透明通道保留），GIF/AVIF 原样上传
- `/media/...` 经 Worker 代理输出并长缓存（图片对象不可变，安全提速）

**主题换肤（一套 CSS 换全站外观）**
- 后台「主题」页：把整个主题文件夹拖进去即安装，一键启用/停用/删除；主题文件存 R2 `themes/`，**不碰代码、无需重新部署**
- 主题 = 一个文件夹（`theme.json` 元信息 + `style.css` 样式），页面骨架把全部颜色/字体抽成了 CSS 变量，会 CSS 就能设计新主题
- 前台与编辑器预览实时加载当前主题；删除正在使用的主题自动回退「系统默认」
- 自带两个示例主题可直接上传体验（`themes-example/ocean-blue` 浅色、`themes-example/ink-night` 深色），详见文末《主题设计指南》

**数据安全**
- 后台「一键备份到 R2」：全量导出 JSON（文章+分类+标签+评论+设置+友链+访问统计），自动保留最近 20 份；也可导出下载到本地
- 「恢复」：从 R2 列表或本地上传文件，将整站恢复到备份时刻（管理员账号保留）
- R2 里的每一份备份都可单独**下载 / 恢复 / 删除**，删除会同步从 R2 移除该文件
- D1 控制台自带“时间旅行”回滚，双重保险

---

## 🚀 部署（一次性）

> 需要：一个 Cloudflare 账号。两种部署方式任选其一：
> - **方式 A（命令行）**：需要一台装有 Node.js 18+ 的电脑，跑下方 4 条命令；
> - **方式 B（零本地，全浏览器）**：不想在本机安装任何软件（含 Node）时使用，见文末《免本地部署（Pages + GitHub）》。绑定变量名见下文注释。

**方式 A（命令行）**

> 📄 **先准备配置文件**：仓库里只提供模板 `wrangler.example.toml`（刻意不带 `wrangler.toml`，以免锁死网页绑定管理，详见文末"绑定锁"坑）。命令行部署前先复制一份：
> ```bash
> cp wrangler.example.toml wrangler.toml     # Windows：copy wrangler.example.toml wrangler.toml
> ```
> 然后打开生成的 `wrangler.toml`，取消 `[[d1_databases]]`、`[[r2_buckets]]` 两段注释，把 `database_id` 换成下一步输出的真实 ID。
> 若改用方式 B（Git 集成），**不要**把模板改名提交上去。

```bash
# 1) 登录（弹出浏览器授权一次）
npx wrangler login

# 2) 创建 D1 数据库与 R2 存储桶
npx wrangler d1 create blog-db     # 把输出的 database_id 填进 wrangler.toml
npx wrangler r2 bucket create blog-assets

# 3) 建表（读取 migrations/ 目录）
npx wrangler d1 migrations apply blog-db

# 4) 部署（目录内含 functions/，自动作为 API 与渲染层）
npx wrangler pages deploy public --project-name blog
```

部署完成后打开 `https://blog.pages.dev/admin`：

1. 首次进入会看到**初始化向导**——填写站点名称、副标题、作者署名与管理员账号（仅此一次可用），提交后自动登录；
2. 点「写文章」，享受所见即所得编辑 → 一键发布；
3. 到「设置」页把站点信息、主题色调好（前台即时生效）。

**安全必做**：在 Pages 控制台 `Settings → Variables and Secrets` 添加同名**加密变量** `AUTH_SECRET`（随机长字符串，覆盖 toml 里的兜底值）。密码以 PBKDF2 加盐哈希存储，会话为 HMAC 签名的 HttpOnly Cookie。

> 关于绑定（D1 `DB`、R2 `BLOG`）：命令行部署时写在 `wrangler.toml` 里即可。**免本地 Git 部署则相反——仓库里只要存在 `wrangler.toml`，Pages 就会锁定网页上的绑定管理**（Bindings 页提示“此项目的绑定在通过 wrangler.toml 进行管理”，Add binding 按钮不可用）。因此 Git 部署请**删除仓库里的 `wrangler.toml`**（删除不影响构建：输出目录 `public` 已存在 Pages 项目设置里），随后在 `Settings → Functions → Bindings` 手动添加绑定（变量名严格用 `DB` 与 `BLOG`），再 Deployments 里 Retry 一次生效。详见文末《免本地部署》第 5 步的坑说明。

---

## 💻 本地预览（可选）

```bash
npx wrangler d1 migrations apply blog-db --local   # 首次建本地库
npx wrangler pages dev public                                # http://127.0.0.1:8788
```

---

## 📁 工程结构

```
cloudflare-blog/
├── CHANGELOG.md             # 完整更新历史（倒序），README 只放最新版本摘要
├── wrangler.example.toml    # 命令行部署的配置模板（复制为 wrangler.toml 并填 database_id 后用）；Git 部署不要提交 wrangler.toml，否则会锁死网页绑定
├── migrations/0001_init.sql # 数据库建表 + 默认设置（命令行迁移用）
├── migrations/d1-console.sql # 去注释压缩版（D1 网页 Console 粘贴用，见免本地部署"建表坑"）
├── themes-example/          # 示例主题（可整个拖入后台安装）
│   ├── ocean-blue/          #   浅色主题：theme.json + style.css
│   └── ink-night/           #   深色主题
├── functions/               # = Workers（Pages Functions）
│   ├── [[path]].js          # 唯一入口：/api/*、前台 SSR、rss/sitemap/robots、/media 与 /theme-assets 代理
│   └── _lib/
│       ├── admin-shell.js   # 后台入口 HTML（自动生成，勿手改；改 index.html 后跑 .gen-admin-shell.mjs）
│       ├── md.js            # 自研 Markdown 渲染器（GFM 子集 + XSS 全转义）
│       ├── hl.js            # 代码高亮（21 种语言 / 7 套配色，输出 hljs 标准类名）
│       ├── md5.js           # Gravatar 头像地址所需的 MD5
│       ├── captcha.js       # 算术验证码：SVG 生成 + 答案 HMAC 签名校验
│       ├── db.js            # D1 数据访问层
│       ├── auth.js          # PBKDF2 密码哈希 + HMAC 会话
│       ├── site.js          # 前台模板与骨架 CSS（THEME_VARS 变量表）+ 主题外链注入
│       └── util.js          # 时间(UTC+8)/转义/分页/MIME 等工具
├── public/                  # = Pages 静态资源
│   ├── _routes.json         # Functions 路由排除表：/admin* 走纯静态托管（不占函数额度）
│   ├── js/site.js           # 前台：评论异步提交 + 阅读量
│   ├── favicon.svg
│   └── admin/               # 后台单页应用（零依赖原生 JS，含「主题」管理页）
│       ├── index.html
│       ├── css/app.css
│       └── js/{app,editor,api,ui}.js   # api.js 内含上传前 WebP 转码
├── .gen-admin-shell.mjs     # 由 public/admin/index.html 重新生成 admin-shell.js（node .gen-admin-shell.mjs）
└── .smoke.mjs               # Markdown 渲染器自检脚本（node .smoke.mjs）
```

依赖：**零 npm 运行时依赖**（渲染器、编辑器、后台全部手写），部署即拷即用。

---

## 🔄 日常使用路径

| 你想做 | 怎么做 |
|---|---|
| 写文章 | 后台 → 写文章 → 所见即所得编辑 → 发布 / 存草稿 |
| 传图片 | 编辑器工具栏 🖼（直接入 R2），或「图片库」批量上传管理 |
| 审评论 | 顶栏「评论」红点=待审 → 通过/删除/回复 |
| 建分类 | 后台「分类与标签」，或在文章页下拉即时使用 |
| 换主题色/站名 | 「设置」保存即生效 |
| 换整套主题 | 「主题」页 → 拖入主题文件夹 → 启用（详见《主题设计指南》） |
| 备份/恢复 | 「备份与恢复」一键备份，或从 R2 记录/本地文件恢复 |
| 域名 | Pages 控制台 `Custom domains` 绑定自己的域名（大陆访问建议绑定已备案域名，步骤见文末《绑定自定义域名》） |

---

## ❓ 常见问题

**Q：每次发布都要重新部署吗？**
不用。正文与站点配置都在 D1 里，前台由 Worker 实时渲染，发布即全网生效。代码更新才需要再次 `wrangler pages deploy public`。

**Q：备份如何做到每天自动？**
免费套餐里 Pages Functions 暂不支持定时触发。常用做法：在 Cloudflare 控制台另建一个 **Cron Worker**（每天 03:00），请求你的站点执行一次备份。极简示例：

```js
// worker（定时任务）——先登录拿会话，再触发备份
export default {
  async scheduled(event, env, ctx) {
    const login = await fetch('https://你的域名/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: env.BLOG_USER, password: env.BLOG_PASS }),
    });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    await fetch('https://你的域名/api/backup', { method: 'POST', headers: { cookie } });
  },
};
```
另外 D1 数据库在控制台自带按时间回滚能力，可做二次保障。

**Q：会不会超免费额度？**
按上面表格：你的博客每月请求量远低于 10 万次/天；图片在 10 GB 内免费。唯一建议：图片是“只增”的对象，偶尔到「图片库」清一清不再使用的图片即可。

**Q：多人共用一个博客后台？**
本系统面向个人/部门单博主场景（一个管理员）。如需多作者，可在 D1 中直接扩展 users 表与 posts.author_id（代码留有扩展空间）。

**Q：安全上有哪些默认措施？**
- 所有读者输入（评论、Markdown 原文）渲染前一律转义；链接只允许 http/https/mailto/tel 及站内相对路径，杜绝 XSS
- 上传仅白名单图片格式并限 8 MB，禁 SVG（防存储型 XSS）
- 评论有蜜罐与 IP 频控；文章草稿仅登录可见
- 管理端全接口需要登录；会话 Cookie 为 HttpOnly + SameSite

---

## 🧪 本地自检

```bash
node .smoke.mjs        # 对 Markdown 渲染器跑一轮输出与 XSS 断言
node .theme-smoke.mjs  # 校验主题系统：变量注入 / 主题外链 / 编辑器预览联动
```

> 提示：Markdown 支持 GFM 常用子集（标题/粗斜体/删除线/引用/列表/任务列表/围栏代码/行内码/链接/图片/表格/分割线/转义）；不支持 setext 标题与多层列表嵌套（缩进内容并入上一项），编辑时请用工具栏生成结构。

---

## 🎨 主题设计指南

主题系统 = **皮肤机制**：页面骨架（布局/响应式）由系统固定提供，骨架里的所有颜色与字体都已抽成 CSS 变量；一个主题就是一个文件夹，通过「覆盖变量 + 补充样式」改变全站观感。**会 CSS 就能设计，不需要懂服务端**。仓库内 `themes-example/` 下有两个可直接上传体验的示例（`ocean-blue` 浅色、`ink-night` 深色），照着改最快。

### 主题文件夹结构

```
my-theme/
├── theme.json      # 必填：元信息（决定后台卡片与 ID）
├── style.css       # 必填：样式（会被加载到前台页面 <head>，晚于骨架样式，可覆盖一切）
└── preview.png     # 选填：后台列表缩略图（建议 480×240 左右）；缺省时显示主题名首字
```

`theme.json` 字段：

```json
{
  "id": "my-theme",                    // 必填：小写字母/数字/连字符，全站唯一，不能是 default
  "name": "我的主题",                   // 后台显示名
  "author": "设计者署名",
  "version": "1.0.0",
  "description": "一句话介绍配色与风格，显示在后台卡片上"
}
```

### 变量速查表（style.css 中覆盖即可换肤）

| 变量 | 默认值 | 控制内容 |
|---|---|---|
| `--bg` | `#f6f7f9` | 页面底色 |
| `--card` | `#fff` | 卡片 / 顶栏 / 页脚底色 |
| `--text` | `#1f2937` | 主文字 |
| `--text-soft` | `#4b5563` | 摘要、归档月份等次要文字 |
| `--muted` | `#6b7280` | 时间戳、弱化文字 |
| `--line` | `#e5e7eb` | 分隔线、卡片边框 |
| `--accent` | `#2563eb` | 主色（链接/按钮/导航高亮/标题竖线） |
| `--accent-soft` | `#eef2ff` | 主色的浅底（标签、导航悬停） |
| `--on-accent` | `#fff` | 主色上的文字（按钮字等） |
| `--tint` | `#f3f6ff` | 表格表头等最浅底 |
| `--quote-bg` / `--quote-text` | `#f3f6ff` / `#374151` | 引用块与评论正文 |
| `--code-bg` / `--code-text` | `#0f172a` / `#e2e8f0` | 代码块 |
| `--inline-code-bg` | `#eef1f5` | 行内代码底 |
| `--admin` / `--admin-soft` / `--admin-text` | 紫色系 | 评论中“博主”标识 |
| `--ok` / `--bad` | 绿 / 红 | 成功 / 错误提示文字 |
| `--font-body` / `--font-code` | 系统默认 | 正文字体 / 等宽字体栈 |

### 设计要点

1. **最小主题 = 一段变量覆盖**，例如深色主题只需在 `style.css` 写 `:root { --bg:#…; --card:#…; --text:#…; }` 等十余行；
2. 除变量外可随意用选择器覆盖骨架样式（`.pc`、`.article`、`.comments`、`.hd`、`.art-body blockquote` 等），类名与默认观感见站点 HTML；
3. style.css 内的相对资源（`url(bg.png)`）需与本文件放同一文件夹，系统按同前缀代理；
4. 后台管理页**不**随主题变化；主题只作用于读者可见的前台与编辑器实时预览。

### 安装 / 切换 / 更新

1. 后台 → 「主题」→ 把整个主题文件夹**拖进虚线框**（或点「＋ 安装新主题」选文件夹）；
2. 卡片上点「启用」→ 全站即时生效（无需重新部署）；
3. 修改主题后重新拖入同一文件夹 → 确认覆盖 → 刷新前台查看；删除正在使用的主题会自动回退「系统默认」；
4. 主题文件存于 R2 `themes/<id>/`，可随时在后台删除。

### 限制说明

- 单文件 ≤ 5 MB；建议整包控制在几 MB 内（图片资源用 CDN/媒体库更佳）；
- 主题只能改“样式”，不能改页面结构（想改结构需改 `functions/_lib/site.js` 骨架并重新部署）。

---

## 🖥️ 免本地部署（Pages + GitHub，零安装）

不想在本机安装 Node.js / Git / Wrangler 时使用，全部操作在浏览器完成：

1. **GitHub**：注册 github.com → 新建 **Private** 私有仓库（不勾选任何初始化文件）→ `Add file → Upload files` 把本文件夹全部内容拖入 → Commit；
2. **Cloudflare**：dash.cloudflare.com 注册；
3. 建 **D1** 数据库（命名随意，如 `blog-db`）→ 打开该库 **Console**，把 `migrations/d1-console.sql` 全文粘贴执行（⚠️ 不要用 `0001_init.sql` 原文直接粘贴，原因见下方"建表坑"警示）；建 **R2** 桶（如 `blog-assets`）；
4. **Pages** → Create project → Connect to Git → 授权并选择仓库 → 框架预设 **None**、构建命令**留空**、输出目录 **`public`** → Save and Deploy（首次部署可能失败，属正常）；
5. **确认仓库里没有 `wrangler.toml`**（仓库自带的是模板 `wrangler.example.toml`，无需处理；若确实存在 `wrangler.toml`，打开它 → 右上角垃圾桶 → Commit）。⚠️ 此文件在 Git 部署模式下**没有作用还会锁死网页绑定**——只要它在，Bindings 页就提示“此项目的绑定在通过 wrangler.toml 进行管理”、无法手动添加（详见下方“绑定锁”坑）。删除不影响构建（输出目录 `public` 已存在 Pages 项目设置里）；
6. 项目 **Settings → Functions → Bindings**：添加 D1 绑定（变量名 **`DB`**）、R2 绑定（变量名 **`BLOG`**）；**Settings → Variables and Secrets**：添加加密变量 **`AUTH_SECRET`**（随机长串）；
7. **Deployments** 里对最新一次点 Retry（重新部署，让绑定生效），随后打开 `https://<项目名>.pages.dev/admin` 完成初始化向导即可。

> ⚠️ **D1 网页 Console 建表坑（2026-09 实测）**：把 `migrations/0001_init.sql` 原样复制到 Console 执行会失败——文件开头的 `--` 注释行与行内注释会被 Console 的多语句解析误判，报 `The request is malformed: Requests without any query are not supported`（看起来像"没粘贴成功"，实际已粘贴、只是解析失败）。典型特征是：单独跑 `SELECT 1;` 正常、整段大 SQL 必失败。
> **正确做法**：改用同目录 `migrations/d1-console.sql`（已去掉全部注释与空行、每条语句独立一行，与 Console 完全兼容），整段粘贴一次执行即可；若个别情况仍报错，把建表语句（前 10 句）与最后的 INSERT 默认设置分两次执行。
> 命令行部署（wrangler d1 migrations apply）不受此问题影响，照常使用 `0001_init.sql`。

> ⚠️ **绑定锁坑（2026-09 实测）**：第 5 步忘记删除 `wrangler.toml` 时，Bindings 页会出现提示“此项目的绑定在通过 wrangler.toml 进行管理”，Add binding 按钮被禁用。原因：Pages 检测到仓库存在 `wrangler.toml` 就把绑定管理权交给配置文件，网页添加入口随之关闭；Git 部署时该文件仅会读取绑定段，而本项目的 `wrangler.toml` 已不含任何绑定——**删掉它网页绑定立即解锁**（若删除后页面仍提示，刷新一次 Bindings 页即可）。其余文件照常上传即可（注意 `migrations/0001_init.sql` 仅命令行迁移使用，网页建表请用 `d1-console.sql`）。

此后：改代码 → 在 GitHub 仓库页按 `.` 键（github.dev 网页编辑器）改完提交，Pages 自动重新部署；写作、传图、审评论、**安装主题**等日常全部在网页后台完成，与本地是否装软件无关。

---

## 🌐 绑定自定义域名（可选，推荐）

> 适用两种部署方式（命令行 / Git 集成），操作完全相同。`*.pages.dev` 域名在大陆网络访问不稳定，个人博客建议绑定自己的域名；**若站点面向大陆用户访问，域名须完成 ICP 备案**（解析到海外节点的未备案域名同样会被阻断）。

### 前提：先想好绑根域还是子域

| 绑定形式 | 示例 | 要求 |
|---|---|---|
| 子域名（推荐） | `blog.example.com` | 无需迁移 DNS，在任意 DNS 处加一条 CNAME 即可 |
| 根域名 | `example.com` | 必须把整个域名托管到 Cloudflare（改 nameserver） |

个人博客建议绑**子域名**：不动主站 DNS、以后换平台只改一条记录。

### 场景 A：域名已经托管在 Cloudflare（DNS 归 Cloudflare 管）

1. dash.cloudflare.com → **Workers & Pages** → 点进你的 Pages 项目 → **Custom domains**（自定义域）；
2. 点 **Set up a custom domain** → 输入要用的域名（如 `blog.example.com`）→ Continue；
3. Cloudflare **自动创建 DNS 记录并签发 SSL 证书**，无需手动加记录；
4. 等状态变成 **Active**（通常几分钟内）即完成。

### 场景 B：域名在阿里云 / 腾讯云等外部注册商

两条路任选：

**路线 1（推荐）：把 DNS 托管整体迁到 Cloudflare**
1. Cloudflare 首页 → **Add a site / 添加站点** → 输入你的域名 → 选 Free 免费套餐；
2. 按提示记下 Cloudflare 分配的两个 nameserver（形如 `xxx.ns.cloudflare.com`）；
3. 去域名注册商控制台，把域名的 **NS 记录**改成这两个值（域名 DNS 服务商处修改）；
4. 等生效后（几小时到 1 天），回到场景 A 操作即可——以后还能免费用 Cloudflare 的 CDN 加速与防护。

**路线 2（不迁移）：在外部 DNS 加一条 CNAME**
1. 先到 Pages 项目 **Custom domains → Set up a custom domain**，输入子域名（如 `blog.example.com`）→ Continue（⚠️ **必须先在这里关联域名**，官方明确：先手动加 CNAME 会导致 522 错误）；
2. 到域名当前的 DNS 服务商控制台，添加记录：

```
类型：CNAME
名称：blog              ← 子域前缀，对应 blog.example.com
目标：<你的项目名>.pages.dev
```

3. 回 Cloudflare 等状态变 **Active** 即可，HTTPS 证书自动签发。

### 绑定后

- 新域名与原来的 `<项目名>.pages.dev` **同时可用**（两个地址访问同一站点，后台、RSS、站点地图全部自动跟随新域名）；
- 如需彻底隐藏 pages.dev 地址、只留自己的域名，可用 Cloudflare 的 Bulk Redirect 功能做 301 跳转，非必需可跳过；
- 若域名配置过 **CAA 记录**（限制证书颁发机构的 DNS 记录）且不含 Cloudflare 允许的机构，证书会签发失败——普通用户一般没有此记录，遇到报错再排查即可。

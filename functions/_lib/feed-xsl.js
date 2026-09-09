// ============================================================
// RSS / Sitemap 的浏览器美化样式表（XSLT 1.0，Chrome / Edge / Firefox 通用）
// 思路：XML 开头用 <?xml-stylesheet?> 指向这里；浏览器直接打开 rss.xml /
// sitemap.xml 时用 XSLT 渲染成漂亮页面；RSS 阅读器与搜索引擎无视该指令，
// 解析到的仍是标准 XML，功能零影响。
// 嵌入函数代码（Workers 无法读文件系统），由 [[path]].js 以 text/xsl 输出。
// ============================================================

const XSL_HEAD = `<?xml version="1.0" encoding="UTF-8"?>`;

const CSS = `
  :root{color-scheme:light}
  *{box-sizing:border-box}
  body{margin:0;padding:36px 18px;background:#eef1f6;color:#1f2937;
    font:15px/1.75 -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif}
  .page{max-width:880px;margin:0 auto}
  .card{background:#fff;border:1px solid #e6e9ef;border-radius:18px;box-shadow:0 2px 14px rgba(20,30,55,.05);overflow:hidden}
  header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:26px 30px 20px;border-bottom:1px solid #eef0f4}
  h1{margin:0;font-size:22px;font-weight:700;letter-spacing:.2px}
  h1 .ico{display:inline-block;margin-right:9px}
  .sub{margin:4px 0 0;color:#6b7280;font-size:13.5px}
  .go{white-space:nowrap;flex:none;text-decoration:none;color:#2563eb;font-size:13.5px;border:1px solid #dbe4f6;background:#f6f8ff;padding:5px 13px;border-radius:999px;margin-top:2px}
  .go:hover{background:#e8eefe}
  .bar{padding:11px 30px;background:#fafbfd;color:#6b7280;font-size:13px;border-bottom:1px solid #f0f2f6}
  .bar b{color:#2563eb;font-weight:700}
  footer{padding:16px 30px 22px;color:#9aa1ac;font-size:12.5px}
  footer a{color:#2563eb;text-decoration:none}
  a.t{text-decoration:none}
`;

// ---------- RSS ----------
export const RSS_XSL = `${XSL_HEAD}
<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">
<xsl:output method="html" encoding="utf-8" indent="no"/>
<xsl:template match="/">
<html lang="zh-CN"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>RSS · <xsl:value-of select="/rss/channel/title"/></title>
<style><![CDATA[${CSS}
  .items{padding:8px 14px}
  .it{display:block;padding:17px 16px;border-bottom:1px solid #f2f4f8;text-decoration:none}
  .it:last-child{border-bottom:none}
  .it:hover{background:#f8faff}
  .t{font-size:16.5px;font-weight:650;color:#1f2937;line-height:1.55}
  .it:hover .t{color:#2563eb}
  .m{margin-top:5px;color:#818a97;font-size:13.5px;line-height:1.7;
     display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  time{color:#2563eb;font-size:12.5px;margin-right:10px;flex:none}
  .no{color:#9aa1ac}
]]></style>
</head><body>
<div class="page"><div class="card">
<header>
  <div>
    <h1><span class="ico">📡</span>RSS 订阅 · <xsl:value-of select="/rss/channel/title"/></h1>
    <div class="sub"><xsl:value-of select="/rss/channel/description"/></div>
  </div>
  <a class="go" href="{/rss/channel/link}">返回博客 ↗</a>
</header>
<div class="bar">最近 <b><xsl:value-of select="count(/rss/channel/item)"/></b> 篇文章
<xsl:if test="/rss/channel/lastBuildDate"> · 更新于 <xsl:value-of select="substring(/rss/channel/lastBuildDate,6,11)"/></xsl:if></div>
<div class="items">
<xsl:for-each select="/rss/channel/item">
<a class="it" href="{link}">
  <span class="t"><xsl:value-of select="title"/></span>
  <div class="m"><time><xsl:value-of select="pdate"/></time><xsl:value-of select="excerpt"/></div>
</a>
</xsl:for-each>
</div>
<footer>此页面由 XSL 样式表美化，仅供在浏览器中阅读；RSS 阅读器与搜索引擎订阅时忽略该样式，仍获得标准 XML 数据。
<a href="/rss.xml">RSS 源</a> · <a href="/">回到首页</a></footer>
</div></div>
</body></html>
</xsl:template>
</xsl:stylesheet>`;

// ---------- Sitemap ----------
export const SITEMAP_XSL = `${XSL_HEAD}
<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform" xmlns:sitemap="http://www.sitemaps.org/schemas/sitemap/0.9">
<xsl:output method="html" encoding="utf-8" indent="no"/>
<xsl:template match="/">
<html lang="zh-CN"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>站点地图 · Sitemap</title>
<style><![CDATA[${CSS}
  table{width:100%;border-collapse:collapse}
  th{font-size:12.5px;color:#8a93a0;font-weight:600;text-align:left;padding:13px 30px 8px;letter-spacing:.4px}
  td{padding:10px 30px;border-top:1px solid #f2f4f8;vertical-align:middle}
  tbody tr:hover{background:#f8faff}
  td.path{font-size:14.5px}
  td.path a{color:#1f2937;text-decoration:none;word-break:break-all}
  td.path a:hover{color:#2563eb}
  td.path a .host{color:#a3abb6;font-size:12.5px;margin-right:6px}
  td.time{color:#818a97;font-size:13px;white-space:nowrap}
  .tag{display:inline-block;font-size:11.5px;padding:1px 9px;border-radius:999px;margin-right:13px;white-space:nowrap;background:#eef2ff;color:#2563eb}
  .tag.h{background:#eefdf3;color:#0a9a5f}
  .tag.c{background:#fef3f2;color:#d6453d}
  .tag.a{background:#fdf5ec;color:#d97706}
  .tag.t{background:#f3eefe;color:#7c4dd3}
  .empty{padding:30px;color:#9aa1ac;text-align:center}
]]></style>
</head><body>
<div class="page"><div class="card">
<header>
  <div>
    <h1><span class="ico">🗺️</span>站点地图</h1>
    <div class="sub">本站全部页面入口 · XML Sitemap（供搜索引擎抓取，此页仅供浏览）</div>
  </div>
  <a class="go" href="/">返回博客 ↗</a>
</header>
<div class="bar">共 <b><xsl:value-of select="count(/sitemap:urlset/sitemap:url)"/></b> 个链接</div>
<table>
<thead><tr><th></th><th>页面</th><th>最后更新</th></tr></thead>
<tbody>
<xsl:for-each select="/sitemap:urlset/sitemap:url">
<xsl:variable name="loc" select="sitemap:loc"/>
<xsl:variable name="path">
  <xsl:choose>
    <xsl:when test="contains($loc,'//') and string-length(substring-after($loc,'//')) &gt; 0">
      <xsl:value-of select="concat('/', substring-after(substring-after($loc,'//'),'/'))"/>
    </xsl:when>
    <xsl:otherwise><xsl:value-of select="$loc"/></xsl:otherwise>
  </xsl:choose>
</xsl:variable>
<xsl:variable name="host">
  <xsl:choose>
    <xsl:when test="contains($loc,'//')"><xsl:value-of select="substring-before(substring-after($loc,'//'),'/')"/></xsl:when>
    <xsl:otherwise></xsl:otherwise>
  </xsl:choose>
</xsl:variable>
<tr>
  <td>
    <xsl:choose>
      <xsl:when test="$path = '/'"><span class="tag h">首页</span></xsl:when>
      <xsl:when test="starts-with($path, '/category/')"><span class="tag c">分类</span></xsl:when>
      <xsl:when test="starts-with($path, '/tag/')"><span class="tag t">标签</span></xsl:when>
      <xsl:when test="starts-with($path, '/post/') or starts-with($path, '/archive')"><span class="tag a">文章</span></xsl:when>
      <xsl:otherwise><span class="tag">页面</span></xsl:otherwise>
    </xsl:choose>
  </td>
  <td class="path"><a href="{$loc}"><span class="host"><xsl:value-of select="$host"/></span><xsl:value-of select="$path"/></a></td>
  <td class="time"><xsl:if test="sitemap:lastmod != ''"><xsl:value-of select="sitemap:lastmod"/></xsl:if></td>
</tr>
</xsl:for-each>
</tbody>
</table>
<footer>此页面由 XSL 样式表美化，仅供在浏览器中查看；搜索引擎读取时忽略该样式，仍获得标准 XML 数据。
<a href="/sitemap.xml">Sitemap 源</a> · <a href="/">回到首页</a></footer>
</div></div>
</body></html>
</xsl:template>
</xsl:stylesheet>`;

-- Ver 0.5 ⑦ IP 归属地缓存
-- 说明：代码里已有自动建表（db.js 的 ensureIpGeoTables），老库不用手动跑这个文件；
--      留档是为了迁移 / 离线排查。
-- 为什么不直接往 comments 表加两列：同一个访客常常留下多条评论，
-- 建独立缓存表按 IP 主键存，一个 IP 只对第三方接口查一次（免费接口都有限流），
-- 而且前台渲染可以直接按 IP 批量取，不用动评论本身的查询结构。
-- loc 位置（「江苏省南京市」）/ isp 运营商（「电信」）/ ok 是否查成功
--   ★ ok=0 也要落库：接口临时挂了不该让同一批 IP 每次打开后台都重新出网，
--     代码里对失败记录只保留一天，之后允许重试。
CREATE TABLE IF NOT EXISTS ip_geo(
  ip TEXT PRIMARY KEY,
  loc TEXT NOT NULL DEFAULT '',
  isp TEXT NOT NULL DEFAULT '',
  ok INTEGER NOT NULL DEFAULT 1,
  src TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

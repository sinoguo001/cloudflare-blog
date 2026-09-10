-- 站点访问统计（PV / UV），可选执行
-- 说明：代码里已有自动建表（db.js 的 ensurePvTables，首次上报时 CREATE TABLE IF NOT EXISTS），
--      正常情况下**不用手动跑这个文件**；留档是为了迁移 / 离线排查时方便。
-- 口径：pv = 整站页面浏览量（刷新计一次，含首页、分类、标签、归档、搜索、文章页）
--      uv = 当日独立访客（按第一方 Cookie blog_vid 去重，跨天重新计）
CREATE TABLE IF NOT EXISTS pv_daily(
  day TEXT PRIMARY KEY,           -- 'YYYY-MM-DD'（北京时间）
  pv  INTEGER NOT NULL DEFAULT 0,
  uv  INTEGER NOT NULL DEFAULT 0
);

-- 访客明细：仅用于当天 UV 去重，保留 60 天（由 recordHit 按 5% 概率清理）
CREATE TABLE IF NOT EXISTS pv_visitor(
  day TEXT NOT NULL,
  vid TEXT NOT NULL,
  PRIMARY KEY(day,vid)
);

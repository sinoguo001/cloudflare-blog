-- 友情链接（博主自己添加的 + 读者申请的，统一走一张表，用 status 区分）
-- 说明：代码里已有自动建表（db.js 的 ensureLinkTable，首次读写 links 时 CREATE TABLE IF NOT EXISTS），
--      正常情况下**不用手动跑这个文件**；留档是为了迁移 / 离线排查时方便。
-- 状态：pending = 待审核（读者申请进来就是这个状态）、approved = 已展示在前台、rejected = 已拒绝
CREATE TABLE IF NOT EXISTS links(
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,                      -- 站点名称
  url         TEXT NOT NULL,                      -- 站点地址（只接受 http / https）
  description TEXT NOT NULL DEFAULT '',           -- 一句话简介
  logo        TEXT NOT NULL DEFAULT '',           -- 图标地址（选填，留空用站点名首字方块）
  contact     TEXT NOT NULL DEFAULT '',           -- 申请人联系方式（选填，仅后台可见，不对外展示）
  reason      TEXT NOT NULL DEFAULT '',           -- 申请留言（选填，仅后台可见）
  sort        INTEGER NOT NULL DEFAULT 0,         -- 排序：小号在前，相同按 id 倒序
  status      TEXT NOT NULL DEFAULT 'pending',    -- pending / approved / rejected
  source      TEXT NOT NULL DEFAULT 'admin',      -- admin = 博主添加；apply = 读者申请
  ip          TEXT NOT NULL DEFAULT '',           -- 申请人 IP（仅用于频控，不对外展示）
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_links_status ON links(status, sort, id DESC);
CREATE INDEX IF NOT EXISTS idx_links_url ON links(url);

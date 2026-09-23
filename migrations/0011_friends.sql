-- Ver 0.4 ⑫ 友圈：订阅别人的 RSS，把抓到的文章展示在自己站上
-- 说明：代码里已有自动建表（db.js 的 ensureFriendTables，首次读写时 CREATE TABLE IF NOT EXISTS），
--      正常情况下**不用手动跑这个文件**；留档是为了迁移 / 离线排查时方便。
-- friend_feeds → 订阅源（一条 = 一个朋友的 RSS）
--   name      留空时第一次抓取会用对方源标题自动补上
--   site_url  站点主页（跳转用），也是抓取时从源里认出来的
--   enabled   0 = 暂停订阅（前台不展示它的文章，也不再自动刷新）
--   last_*    上一次抓取的时间/HTTP 状态/错误原因，后台列表直接显示，便于排查
-- friend_posts → 抓回来的文章正文摘要
--   guid      源里的唯一标识，缺失时退回文章链接；与 feed_id 一起做去重（同源同篇只存一份）
--   每个源只保留最近 30 条，避免老文章无限堆积
CREATE TABLE IF NOT EXISTS friend_feeds(
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL DEFAULT '',
  url         TEXT NOT NULL,
  site_url    TEXT NOT NULL DEFAULT '',
  avatar      TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  sort        INTEGER NOT NULL DEFAULT 0,
  enabled     INTEGER NOT NULL DEFAULT 1,
  last_fetch  TEXT NOT NULL DEFAULT '',
  last_status INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ffeed_enabled ON friend_feeds(enabled, sort, id);

CREATE TABLE IF NOT EXISTS friend_posts(
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  feed_id      INTEGER NOT NULL,
  guid         TEXT NOT NULL,
  title        TEXT NOT NULL,
  link         TEXT NOT NULL,
  summary      TEXT NOT NULL DEFAULT '',
  author       TEXT NOT NULL DEFAULT '',
  published_at TEXT NOT NULL,
  fetched_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fpost_uniq ON friend_posts(feed_id, guid);
CREATE INDEX IF NOT EXISTS idx_fpost_time ON friend_posts(published_at DESC, id DESC);

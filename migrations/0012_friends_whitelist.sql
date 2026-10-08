-- Ver 0.5 ⑤ 友圈白名单：订阅分「信任」与「待审」两档
-- 说明：与 0011 一样，代码里已有自动补列（db.js 的 ensureFriendTables 会 PRAGMA 后 ALTER），
--      老库不用手动跑这个文件；留档是为了迁移 / 离线排查。
-- friend_feeds.whitelist → 1 = 白名单，抓回来的文章直接在前台显示
--                           0 = 不在白名单，抓回来的文章先入库但只在后台「待审核」里
-- friend_posts.status    → approved 前台显示 / pending 待审核 / rejected 已忽略
--   ★ 默认值必须是 approved：升级时已有的行会被填成 approved，
--     否则老站升级后全部文章会瞬间从前台消失。
ALTER TABLE friend_feeds ADD COLUMN whitelist INTEGER NOT NULL DEFAULT 0;
ALTER TABLE friend_posts ADD COLUMN status TEXT NOT NULL DEFAULT 'approved';

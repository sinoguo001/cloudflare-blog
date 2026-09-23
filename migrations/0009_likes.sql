-- Ver 0.4 ⑦ 文章点赞
-- 独立一张表，不给 posts 加冗余列：点赞数用 COUNT 取，避免两处计数不一致。
-- 主键即 (post_id, vid)：同一访客对同一篇文章只能赞一次（再点一次是取消）。
CREATE TABLE IF NOT EXISTS post_likes(
  post_id INTEGER NOT NULL,
  vid TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(post_id,vid)
);

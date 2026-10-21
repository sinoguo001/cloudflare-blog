-- Ver 0.7 ⑪ 回收站：文章与页面删除先进回收站
-- deleted_at 为空串表示「没在回收站」，非空存的是删除时间（北京时间字符串）。
-- 不另开一张表：回收站要保留原来的 id、别名、标签、评论与发布时间，
-- 复制一份再删原行既会把 slug 的唯一约束搞乱，还原时也拼不回原来的引用关系。
ALTER TABLE posts ADD COLUMN deleted_at TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_posts_deleted ON posts(deleted_at);

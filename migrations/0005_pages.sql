-- Ver 0.4 ① 独立页面：posts 表增加内容类型与导航开关
-- 老数据全部落在 'post'（默认值），不会把已有文章变成页面。
ALTER TABLE posts ADD COLUMN type   TEXT    NOT NULL DEFAULT 'post';  -- post 文章 | page 独立页面
ALTER TABLE posts ADD COLUMN in_nav INTEGER NOT NULL DEFAULT 1;       -- 页面是否显示在站点导航（1 显示）
CREATE INDEX IF NOT EXISTS idx_posts_type ON posts(type, status);

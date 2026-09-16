-- Ver 0.4 ② 二级分类：categories 增加父分类指针
-- parent_id = 0 表示顶级分类；非 0 表示挂在某个顶级分类下的二级分类（只支持两级）。
-- 老分类默认值 0，全部是顶级分类，行为与之前完全一致。
ALTER TABLE categories ADD COLUMN parent_id INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories(parent_id);

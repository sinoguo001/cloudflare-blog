-- Ver 0.4 ③ 导航栏自定义：分类是否进入导航栏
-- in_nav = 0 不显示（默认，升级后导航栏与之前完全一样）；1 显示。
-- 二级分类不单独占导航位：父分类显示时，它的二级分类在下拉菜单里展开。
ALTER TABLE categories ADD COLUMN in_nav INTEGER NOT NULL DEFAULT 0;

-- Ver 0.4 ④ 文章加密
-- password 为空串表示不加密；非空则前台需输入正确密码才能看正文。
-- 密码以明文存库（后台要回填显示），cookie 里只存它的 SHA-256，不下发明文。
ALTER TABLE posts ADD COLUMN password TEXT NOT NULL DEFAULT '';

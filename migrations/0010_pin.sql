-- Ver 0.4 ⑪ 文章置顶
-- pin = 0 表示不置顶；大于 0 表示置顶优先级，数字越大越靠前。
-- 服务端每次调整都会把已置顶文章重排成连续的 1..N（N 为最靠前的那篇），
-- 所以不依赖任何具体数值，也不会出现并列。
ALTER TABLE posts ADD COLUMN pin INTEGER NOT NULL DEFAULT 0;

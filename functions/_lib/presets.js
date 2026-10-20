// ============================================================
// 预置主题（Ver 0.7 ⑥）
// ------------------------------------------------------------
// 随仓库一起发布的主题：文件放在 public/themes/<id>/，由静态资源层托管，
// 不需要先上传到 R2 就能在后台「主题」页看到、预览、启用。
//
// 为什么元信息在这里再写一份，而不是运行时去 ASSETS 里读 theme.json：
//   · /api/themes 是一个「打开页面就要返回」的列表接口，每个预置主题多一次
//     子请求 = 多一次边缘往返；ASSETS 取不到时列表还会残缺。
//   · 代价是「改名字要改两处」，所以 .preset-smoke.mjs 里有一条断言：
//     本文件的每个字段必须与 public/themes/<id>/theme.json 完全一致。
//     一旦漂了，全量回归会红，不会悄悄不一致。
//
// 新增一个预置主题只有两步：
//   ① 把整个文件夹放进 public/themes/<id>/（必须含 style.css；建议带 preview.png）
//   ② 在下面 LIST 里加一条
// ============================================================

export const LIST = [
  {
    id: 'jp-washi',
    name: '和纸 · 日式小清新',
    author: '云尚博客',
    version: '1.0.0',
    description: '生成り米白纸底 + 朱色点睛 + 若竹绿点缀，衬线标题、方形印章标签、虚线分隔。单栏窄版与双栏侧边栏两种版式都已适配，含夜间「夜樱」配色。',
  },
  {
    id: 'wp-2012',
    name: '印记 2012',
    author: '移植自 huhexian/2012-huhexian（GPL-2.0）',
    version: '1.0.0',
    description: '灰底白纸 + 蓝色链接的极简中文博客外观：标题字距拉宽、导航通栏双细线、正文首行缩进两字、小标题左侧蓝竖线。移植自 WordPress 主题 2012-huhexian，只改样式，不动页面结构。',
  },
];

const IDS = new Set(LIST.map((t) => t.id));

export const isPreset = (id) => IDS.has(String(id || ''));

// 列表接口用：附上 builtin / preset 两个标记，后台据此显示徽章、隐藏「删除」
export const all = () => LIST.map((t) => ({ ...t, builtin: true, preset: true }));

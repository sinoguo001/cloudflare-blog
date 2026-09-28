// ============================================================
// 内容更新后清 Cloudflare 边缘缓存（Ver 0.5 ① B 部分）
//
// 为什么不能只用 cache.delete：它**只清当前机房**。要让所有机房都生效，
// 必须调 Cloudflare 的 purge API。
//
// 配置（Pages 项目 → Settings → Variables and Secrets）：
//   CF_ZONE_ID   —— 域名所在区域的 Zone ID（明文变量即可）
//   CF_API_TOKEN —— 有「Cache Purge」权限的 API Token（请设为 Secret）
//   CF_PURGE_MODE=all（可选）—— 一律整区清空，不按 URL
// 没配就静默跳过：发布照常成功，只是页面最长 10 分钟（缓存新鲜期）才更新。
// ============================================================

const API = 'https://api.cloudflare.com/client/v4';
const MAX_PER_CALL = 30;   // purge API 单次 URL 上限

const cfgOf = (env) => ({
  zone: String((env && env.CF_ZONE_ID) || '').trim(),
  token: String((env && env.CF_API_TOKEN) || '').trim(),
  all: String((env && env.CF_PURGE_MODE) || '').trim().toLowerCase() === 'all',
});

// 配没配好 —— 调用方据此决定要不要费劲拼 URL 列表
export const ready = (env) => {
  const c = cfgOf(env);
  return !!(c.zone && c.token);
};

async function call(env, body) {
  const c = cfgOf(env);
  if (!c.zone || !c.token) return { ok: false, skipped: true };
  try {
    const r = await fetch(`${API}/zones/${c.zone}/purge_cache`, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + c.token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    const ok = r.ok && !!(j && j.success !== false);
    if (!ok) console.error('purge failed:', r.status, JSON.stringify((j && j.errors) || []).slice(0, 300));
    return { ok, status: r.status, errors: (j && j.errors) || [] };
  } catch (e) {
    console.error('purge error:', (e && e.message) || e);
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

// 按 URL 清（去重；超过 30 个自动分批）。CF_PURGE_MODE=all 时退化为整区清空。
export async function urls(env, list) {
  if (!ready(env)) return { ok: false, skipped: true };   // 没配就一个请求也别发
  const items = [...new Set((list || []).filter(Boolean))];
  if (!items.length) return { ok: true, skipped: true };
  if (cfgOf(env).all) return call(env, { purge_everything: true });
  let ok = true;
  for (let i = 0; i < items.length; i += MAX_PER_CALL) {
    const r = await call(env, { files: items.slice(i, i + MAX_PER_CALL) });
    if (!r.ok) ok = false;
  }
  return { ok };
}

// 整区清空：结构性改动（导航、分类、设置、主题）会影响到「每一页」，按 URL 列不全
export async function all(env) {
  return call(env, { purge_everything: true });
}

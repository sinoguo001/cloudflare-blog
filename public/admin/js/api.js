// 后台 API 封装

// ---------- 上传前把图片转成 WebP（在浏览器里完成） ----------
// 为什么不在服务端转：Cloudflare Workers 免费版每个请求只有 10ms CPU 时间，
// 而编码一张 WebP 需要几十到几百毫秒，放服务端必然触发 Error 1102（超出资源限制）。
// 放浏览器端则是零成本：不占 Worker 额度，还能减少上传流量、加快上传速度。
const WEBP_QUALITY = 0.85;      // 画质与体积的平衡点，0.8~0.9 视觉上几乎无损
const WEBP_MAX_PIXELS = 30e6;   // 超过 3000 万像素跳过转换（避免 canvas 尺寸超限）
// 只转这几种；GIF 多为动图（canvas 只取首帧会丢动画）、WebP/AVIF 已是目标格式、ICO 不适合
const CONVERTIBLE = { 'image/png': 1, 'image/jpeg': 1, 'image/jpg': 1, 'image/bmp': 1 };

function dataUrlToBlob(url) {
  const bin = atob(url.split(',')[1]);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return new Blob([u], { type: 'image/webp' });
}

export async function toWebp(file) {
  if (!file || !CONVERTIBLE[file.type]) return file;
  try {
    const bmp = await createImageBitmap(file);
    try {
      if (bmp.width * bmp.height > WEBP_MAX_PIXELS) return file;
      const cv = document.createElement('canvas');
      cv.width = bmp.width;
      cv.height = bmp.height;
      cv.getContext('2d').drawImage(bmp, 0, 0);
      // 首选异步 toBlob（不阻塞界面）；个别环境下它可能始终不回调，
      // 超时后改用同步 toDataURL 兜底，保证转换不会无声卡死。
      let blob = await Promise.race([
        new Promise((res) => cv.toBlob(res, 'image/webp', WEBP_QUALITY)),
        new Promise((res) => setTimeout(() => res(null), 4000)),
      ]);
      if (!blob || blob.type !== 'image/webp') {
        const url = cv.toDataURL('image/webp', WEBP_QUALITY);
        // 不支持 WebP 编码的浏览器会静默回退成 PNG，必须校验真实类型
        if (!url.startsWith('data:image/webp')) return file;
        blob = dataUrlToBlob(url);
      }
      // 转换后没变小就用原图，保证永远不会"越转越大"
      if (blob.size >= file.size) return file;
      const name = (file.name || 'image').replace(/\.[^.]+$/, '') + '.webp';
      return new File([blob], name, { type: 'image/webp', lastModified: Date.now() });
    } finally { if (bmp.close) bmp.close(); }
  } catch (e) {
    return file; // 任何异常都回退原图，不阻断上传
  }
}

export const API = {
  async req(method, url, body) {
    const opt = { method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) {
      opt.headers['content-type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    const r = await fetch('/api' + url, opt);
    const ct = r.headers.get('content-type') || '';
    let data = null;
    try {
      data = ct.includes('application/json') ? await r.json() : await r.text();
    } catch (e) { /* ignore */ }
    if (r.status === 401 && !url.startsWith('/auth') && !url.startsWith('/state')) {
      if (location.hash !== '#/login') location.hash = '#/login';
      const e = new Error('请先登录');
      e.code = 401;
      throw e;
    }
    if (!r.ok) {
      const e = new Error((data && data.error) || '请求失败 (' + r.status + ')');
      e.code = r.status;
      throw e;
    }
    return data;
  },
  get(u) { return this.req('GET', u); },
  post(u, b) { return this.req('POST', u, b); },
  put(u, b) { return this.req('PUT', u, b); },
  patch(u, b) { return this.req('PATCH', u, b); },
  del(u) { return this.req('DELETE', u); },
  // 图片上传（浏览器端自动转 WebP 后直传 R2；opts.raw = true 可跳过转换）
  async upload(file, opts = {}) {
    const src = opts.raw ? file : await toWebp(file);
    const r = await fetch('/api/media', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': src.type },
      body: src,
    });
    let d = {};
    try { d = await r.json(); } catch (e) { /* ignore */ }
    if (!r.ok) throw new Error(d.error || '上传失败');
    // 附带转换结果供界面提示用（不影响后端返回的 key / url）
    if (src !== file) d._webp = { from: file.size, to: src.size };
    return d;
  },
  // 主题文件上传（按相对路径写入 R2 themes/<dir>/<path>）
  async uploadThemeFile(file, dir, relPath) {
    const qs = new URLSearchParams({ dir, path: relPath });
    const r = await fetch('/api/themes/upload?' + qs.toString(), {
      method: 'POST', credentials: 'same-origin', body: file,
    });
    let d = {};
    try { d = await r.json(); } catch (e) { /* ignore */ }
    if (!r.ok) throw new Error(d.error || '上传失败 (' + r.status + ')');
    return d;
  },
};

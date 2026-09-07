// 后台 API 封装
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
  // 图片上传（原图直传 R2）
  async upload(file) {
    const r = await fetch('/api/media', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': file.type },
      body: file,
    });
    let d = {};
    try { d = await r.json(); } catch (e) { /* ignore */ }
    if (!r.ok) throw new Error(d.error || '上传失败');
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

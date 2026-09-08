// 后台 UI 小工具：转义 / 弹层 / 提示 / 格式化
export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

let toastTimer = null;
export function toast(msg, type = 'ok') {
  let box = document.getElementById('toast');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toast';
    document.body.appendChild(box);
  }
  const node = el(`<div class="tst ${type}">${esc(msg)}</div>`);
  box.appendChild(node);
  setTimeout(() => { node.style.opacity = '0'; node.style.transition = 'opacity .3s'; }, 2600);
  setTimeout(() => node.remove(), 2950);
}

// 通用对话框，返回 Promise<action 值>。actions: [{val,label,cls}]
export function dialog({ title, bodyHtml, actions = [{ val: 'ok', label: '确定', cls: 'p' }, { val: 'cancel', label: '取消', cls: 'g' }], onSubmit } = {}) {
  return new Promise((resolve) => {
    let root = document.getElementById('modal-root');
    if (!root) {
      root = document.createElement('div');
      root.id = 'modal-root';
      document.body.appendChild(root);
    }
    const mk = (a) => `<button class="btn ${a.cls || ''}" data-val="${esc(a.val)}">${esc(a.label)}</button>`;
    const node = el(`
      <div class="mask"><div class="dlg">
        <h3>${esc(title || '')}</h3>
        <div class="dlg-body">${bodyHtml || ''}</div>
        <div class="dlg-ops">${actions.map(mk).join('')}</div>
      </div></div>`);
    const close = (val) => { node.remove(); resolve(val); };
    node.addEventListener('click', (ev) => {
      if (ev.target.classList.contains('mask')) return close('cancel');
      const btn = ev.target.closest('button[data-val]');
      if (!btn) return;
      const val = btn.dataset.val;
      if (val === 'ok' && onSubmit) {
        const r = onSubmit(node.querySelector('.dlg'));
        if (r === false) return;
      }
      close(val);
    });
    root.appendChild(node);
  });
}

export async function confirmDanger(message, title = '危险操作确认') {
  return (await dialog({
    title,
    bodyHtml: `<div style="background:#fef3f2;border:1px solid #fecaca;border-radius:10px;padding:12px 14px;color:#b91c1c">${esc(message)}</div>`,
    actions: [{ val: 'ok', label: '确认执行', cls: 'd' }, { val: 'cancel', label: '取消', cls: 'g' }],
  })) === 'ok';
}

export function fmtSize(n) {
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

export function fmtTime(s) {
  return s ? String(s).slice(0, 16) : '';
}

export function debounce(fn, ms = 300) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export const IMG = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico'];
export function isImage(url) {
  const e = (url.split('?')[0].split('.').pop() || '').toLowerCase();
  return IMG.includes(e);
}

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

// ---------- 全页忙碌遮罩 ----------
// 用途：保存这类「点一下要等好几秒」的操作，一点下去整页立刻蒙灰 + 转圈，
// 明确告诉你「在跑，不是卡住了」，同时把底下的按钮全挡住、防重复提交。
// 返回**释放函数**，必须放在 finally 里 —— 成功失败都要撤掉，绝不能把页面锁死。
// 用计数而不是布尔：万一两个操作叠在一起，先结束的那个不会把还在跑的那个的遮罩提前撤掉。
let busyN = 0;
let busyMask = null;
let busyTimer = null;

export function busy(msg = '正在处理…', note = '请勿关闭或刷新页面') {
  busyN++;
  if (!busyMask) {
    busyMask = el(`<div class="mask busy" aria-busy="true" aria-live="assertive">
      <div class="busy-box"><i class="spin" aria-hidden="true"></i><b class="busy-msg">${esc(msg)}</b><span class="busy-note">${esc(note)}</span></div>
    </div>`);
    // 吞掉遮罩上的交互：既拦住误触，也避免点穿到底下的按钮
    busyMask.addEventListener('mousedown', (e) => e.stopPropagation());
    busyMask.addEventListener('click', (e) => e.stopPropagation());
    document.body.appendChild(busyMask);
    const t0 = Date.now();
    const node = busyMask.querySelector('.busy-msg');
    const tail = busyMask.querySelector('.busy-note');
    // 秒数只在超过 3 秒后才出现：快请求闪一下数字反而晃眼，慢了才需要它交代「真的在跑」
    busyTimer = setInterval(() => {
      if (!busyMask) return;
      const s = Math.floor((Date.now() - t0) / 1000);
      node.textContent = s >= 3 ? `${msg} 已等待 ${s} 秒` : msg;
      tail.textContent = s >= 8 ? '网络较慢，仍在处理，请勿刷新页面' : note;
    }, 500);
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    busyN = Math.max(0, busyN - 1);
    if (busyN > 0 || !busyMask) return;
    clearInterval(busyTimer);
    const m = busyMask;
    busyMask = null;
    m.classList.add('out'); // 淡出一下再移除，避免画面「啪」地跳回彩色
    setTimeout(() => m.remove(), 180);
  };
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

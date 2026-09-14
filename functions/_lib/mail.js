// ============================================================
// 邮件通知：SMTP 客户端 + 邮件模板
//
// 为什么自己写 SMTP：Cloudflare Workers 只有 fetch 与 cloudflare:sockets 两种出网能力，
// 官方文档明确「禁止 25 端口」，但 465（隐式 TLS）与 587（STARTTLS）是允许的，
// 所以用 cloudflare:sockets 直连 163 / QQ 这类 SMTP 服务器是可行的。
// ⚠️ 25 端口在本项目里直接不给选项，避免配了发不出去。
//
// 为什么 connect() 由外部传入：Node 环境没有 cloudflare:sockets 模块，
// 顶层 import 会让本地测试直接崩在加载阶段；而 Pages Functions 的打包器又只稳妥支持
// 顶层静态 import（运行时动态 import 在真机上可能加载失败、接口直接 5xx）。
// 折中：调用方（functions/[[path]].js）静态 import 后把 connect 传进来，
// 本地测试则注入假 socket，协议流程（EHLO / AUTH / DATA）照样能做命令级断言。
//
// ⚠️ 踩过的坑：connect 的地址字段是 hostname 不是 host，写错本地测试查不出来
// （假 socket 不校验字段），上线表现为连不上。测试里已对字段名单独断言。
// ============================================================

// ---------- 服务商预设 ----------
// port/secure 成对给出：465（或 994）= 隐式 TLS，587 = STARTTLS。
// ports / secures 是该服务商**实际开放**的端口与加密方式，按各家官方帮助文档核对（2026-09）。
// ⚠️ 网易 163 / 126 / Yeah 与阿里云都**不开 587**；Office365 反过来**不支持 465**。
// ⚠️ 163 与 Yeah 还有 994 端口，同样走隐式 SSL，与 465 等价。
export const MAIL_PROVIDERS = [
  { id: '163', name: '网易 163 邮箱', host: 'smtp.163.com', port: 465, secure: 'ssl', ports: [465, 994], secures: ['ssl'],
    passHint: '填「客户端授权码」，不是邮箱登录密码。获取：网页版 163 → 设置 → POP3/SMTP/IMAP → 开启 SMTP 服务 → 按提示拿到授权码' },
  { id: '126', name: '网易 126 邮箱', host: 'smtp.126.com', port: 465, secure: 'ssl', ports: [465], secures: ['ssl'],
    passHint: '填「客户端授权码」。获取：网页版 126 → 设置 → POP3/SMTP/IMAP → 开启 SMTP 服务' },
  { id: 'yeah', name: '网易 Yeah.net', host: 'smtp.yeah.net', port: 465, secure: 'ssl', ports: [465, 994], secures: ['ssl'],
    passHint: '填「客户端授权码」，获取方式同 163' },
  { id: 'qq', name: 'QQ 邮箱', host: 'smtp.qq.com', port: 465, secure: 'ssl', ports: [465, 587], secures: ['ssl', 'starttls'],
    passHint: '填「授权码」。获取：QQ 邮箱 → 设置 → 账号 → 开启 IMAP/SMTP 服务 → 发短信后生成 16 位授权码' },
  { id: 'foxmail', name: 'Foxmail 邮箱', host: 'smtp.foxmail.com', port: 465, secure: 'ssl', ports: [465, 587], secures: ['ssl', 'starttls'],
    passHint: '填「授权码」，获取方式与 QQ 邮箱相同' },
  { id: 'gmail', name: 'Gmail', host: 'smtp.gmail.com', port: 465, secure: 'ssl', ports: [465, 587], secures: ['ssl', 'starttls'],
    passHint: '需先开启两步验证，再用「应用专用密码」（16 位）登录，不能用 Google 账号密码' },
  { id: 'outlook', name: 'Outlook / Office 365', host: 'smtp.office365.com', port: 587, secure: 'starttls', ports: [587], secures: ['starttls'],
    passHint: '微软官方只开放 587（STARTTLS），465 连不上；开了两步验证要用「应用密码」，且需在账户设置里启用 SMTP AUTH' },
  { id: 'aliyun', name: '阿里云邮箱', host: 'smtp.aliyun.com', port: 465, secure: 'ssl', ports: [465], secures: ['ssl'],
    passHint: '填邮箱密码或单独设置的「三方客户端密码」，需在邮箱设置里开启 SMTP 服务（官方说明 80 与 587 端口未开通）' },
  { id: 'exmail', name: '腾讯企业邮', host: 'smtp.exmail.qq.com', port: 465, secure: 'ssl', ports: [465, 587], secures: ['ssl', 'starttls'],
    passHint: '填「客户端专用密码」（企业邮后台生成），不是登录密码' },
  { id: 'custom', name: '自定义', host: '', port: 465, secure: 'ssl', ports: [], secures: ['ssl', 'starttls'],
    passHint: '按服务商要求填写；多数国内邮箱需要的是「授权码 / 客户端专用密码」而非登录密码' },
];

export const providerById = (id) => MAIL_PROVIDERS.find((p) => p.id === id) || MAIL_PROVIDERS[MAIL_PROVIDERS.length - 1];

// ---------- 邮件模板 ----------
export const MAIL_TEMPLATES = [
  { id: 'card', name: '卡片式（推荐）', desc: '带站点头部、引用块与按钮的 HTML 邮件，手机上也好读' },
  { id: 'plain', name: '纯文本', desc: '无 HTML 无样式，兼容性最好，最不容易进垃圾箱' },
  { id: 'minimal', name: '极简一行', desc: '只有一句摘要加一个链接，最短，适合当提醒看' },
];

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const nl2br = (s) => esc(s).replace(/\n/g, '<br>');

/**
 * 渲染一封通知邮件
 * @param {string} tpl  模板 id：card / plain / minimal
 * @param {object} d    { kind, site, siteUrl, postTitle, postUrl, adminUrl, author, email, content, pending }
 */
export function renderMail(tpl, d) {
  const site = d.site || '博客';
  const who = d.author || '访客';
  const title = d.postTitle || '文章';
  const isComment = d.kind !== 'reply';
  const subject = isComment
    ? `【${site}】文章《${title}》收到新评论`
    : `【${site}】你在《${title}》的评论有了新回复`;
  const head = isComment ? `${who} 在你的文章《${title}》发表了评论：` : `博主回复了你在《${title}》的评论：`;
  const tail = isComment
    ? (d.pending ? '该评论当前为「待审核」状态，需你在后台通过后才会公开显示。' : '该评论已直接发布。')
    : '（本邮件只发送给本条评论的留言者）';
  const action = isComment ? (d.pending ? '去后台审核' : '去后台查看') : '查看回复';
  const actUrl = isComment ? (d.adminUrl || d.postUrl) : d.postUrl;

  // --- 极简：一行 + 链接 ---
  if (tpl === 'minimal') {
    const oneLine = isComment
      ? `${who}：${String(d.content || '').replace(/\s+/g, ' ').slice(0, 80)}`
      : `博主：${String(d.content || '').replace(/\s+/g, ' ').slice(0, 80)}`;
    return {
      subject,
      text: [
        `${site} · ${head}`,
        oneLine,
        `${action}：${actUrl}`,
        d.postUrl ? `文章：${d.postUrl}` : '',
        '', tail,
      ].filter((x) => x !== '').join('\n'),
    };
  }

  // --- 纯文本 ---
  const text = [
    `${site} · ${head}`, '', String(d.content || ''), '',
    `文章：${title}`,
    `链接：${d.postUrl || ''}`,
    isComment && d.email ? `留言者邮箱：${d.email}` : '',
    isComment ? `管理地址：${d.adminUrl || ''}` : '',
    '', tail,
    '', `—— 本邮件由 ${site} 自动发送`,
  ].filter((x) => x !== '').join('\n');

  if (tpl === 'plain') return { subject, text };

  // --- 卡片 HTML ---
  const html = `<div style="background:#f5f7fa;padding:22px 12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb">
    <div style="background:#2563eb;color:#fff;padding:16px 22px;font-size:16px;font-weight:700">${esc(site)}</div>
    <div style="padding:22px">
      <div style="font-size:17px;font-weight:700;color:#111827;margin-bottom:14px">${esc(subject)}</div>
      <div style="color:#6b7280;font-size:14px;margin-bottom:10px">${esc(head)}</div>
      <div style="background:#f9fafb;border-left:3px solid #2563eb;border-radius:6px;padding:12px 14px;color:#1f2937;font-size:14.5px;line-height:1.75;white-space:pre-wrap">${nl2br(d.content)}</div>
      <div style="margin-top:18px">
        <a href="${esc(actUrl)}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px;font-size:14px">${esc(action)}</a>
      </div>
      <div style="margin-top:16px;color:#9ca3af;font-size:12.5px;line-height:1.7">
        文章：${esc(title)}<br>
        ${d.postUrl ? `链接：<a href="${esc(d.postUrl)}" style="color:#6b7280">${esc(d.postUrl)}</a><br>` : ''}
        ${isComment && d.email ? `留言者邮箱：${esc(d.email)}<br>` : ''}
        ${esc(tail)}
      </div>
    </div>
    <div style="padding:12px 22px;border-top:1px solid #f3f4f6;color:#9ca3af;font-size:12px">本邮件由 ${esc(site)} 自动发送，无需回复。</div>
  </div>
</div>`;
  return { subject, text, html };
}

// ---------- MIME 构建 ----------
const b64 = (str) => {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
};
// 每行 76 字符折行（RFC 2045）
const fold = (s) => (s.match(/.{1,76}/g) || []).join('\r\n');
const addr = (name, mail) => (name ? `"${String(name).replace(/["\\]/g, '')}" <${mail}>` : `<${mail}>`);

export function buildMime(o) {
  const { from, fromName, to, subject, text, html } = o;
  const now = new Date();
  const date = now.toUTCString();
  const mid = `<${now.getTime()}.${Math.random().toString(36).slice(2, 10)}@${(from || 'blog').split('@')[1] || 'blog'}>`;
  const head = [
    `From: ${addr(fromName, from)}`,
    `To: <${to}>`,
    `Subject: =?UTF-8?B?${b64(subject)}?=`,
    `Date: ${date}`,
    `Message-ID: ${mid}`,
    'MIME-Version: 1.0',
  ];
  if (html) {
    const b = '----=_b' + now.getTime().toString(36);
    head.push(`Content-Type: multipart/alternative; boundary="${b}"`, '');
    return [
      ...head,
      `--${b}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64', '',
      fold(b64(text || '')),
      `--${b}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64', '',
      fold(b64(html)),
      `--${b}--`, '',
    ].join('\r\n');
  }
  head.push('Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '');
  return [...head, '', fold(b64(text || '')), ''].join('\r\n');
}

// DATA 里以 . 开头的行要双写（RFC 5321 4.5.2）
const dotStuff = (s) => s.replace(/\r\n\./g, '\r\n..').replace(/^\./m, '..');

// ---------- SMTP 会话 ----------
// 多行响应：以 `NNN-` 续行，`NNN ` 收尾
function takeReply(buf) {
  const parts = buf.split('\r\n');
  const complete = parts.slice(0, -1);
  const start = complete.findIndex((l) => /^\d{3}[- ]/.test(l));
  if (start < 0) return null;
  const block = [];
  for (let i = start; i < complete.length; i += 1) {
    block.push(complete[i]);
    if (/^\d{3} /.test(complete[i])) {
      return {
        code: parseInt(complete[i].slice(0, 3), 10),
        text: block.join('\n'),
        rest: parts.slice(i + 1).join('\r\n'),
      };
    }
  }
  return null;
}

async function readReply(reader, state) {
  const dec = new TextDecoder();
  for (;;) {
    const hit = takeReply(state.buf);
    if (hit) { state.buf = hit.rest; return hit; }
    const { value, done } = await reader.read();
    if (done) throw new Error('SMTP 连接被服务器提前关闭');
    state.buf += dec.decode(value, { stream: true });
  }
}

class Smtp {
  constructor(socket) {
    this.socket = socket;
    this.writer = socket.writable.getWriter();
    this.reader = socket.readable.getReader();
    this.state = { buf: '' };
    this.enc = new TextEncoder();
  }

  async cmd(line, expect) {
    if (line !== null) await this.writer.write(this.enc.encode(line + '\r\n'));
    const r = await readReply(this.reader, this.state);
    if (expect && !expect.includes(r.code)) {
      throw new Error(`SMTP ${r.code}：${r.text.split('\n').pop()}`);
    }
    return r;
  }

  async close() {
    try { await this.writer.close(); } catch (e) { /* 关闭失败无需处理 */ }
    try { this.socket.close(); } catch (e) { /* 同上 */ }
  }
}

/**
 * 发送一封邮件
 * @param {object} cfg  { host, port, secure:'ssl'|'starttls', user, pass, from, fromName, timeoutMs }
 * @param {object} msg  { to, subject, text, html }
 * @param {function} connectFn  connect(address, options) => Socket（address 用 hostname 字段，
 *   secureTransport 等选项放第二个参数）
 * @param {object} [prog]  可选的进度记录对象，外层超时时用它报出卡在哪一步
 *   由调用方（functions/[[path]].js）静态 import 'cloudflare:sockets' 后传入。
 *   为什么不在这里 import：Pages Functions 的打包器只稳妥支持静态 import，
 *   而顶层静态 import 会让本地 Node 测试直接崩在模块加载阶段；由调用方传入，两边都能跑。
 *   本地测试则注入假 socket 工厂 —— 注意假工厂不校验字段，所以 address 的字段名
 *   必须在测试里单独断言（曾经写成 host，漏过 72 个用例，上线才暴露）。
 */
/**
 * 465 / 994 是隐式 SSL 端口（网易系两家都提供），587 才是 STARTTLS。
 * 端口优先于选项：端口填了 465 却选 STARTTLS 也按 SSL 连 ——
 * 否则明文去连 SSL 端口，服务器等握手、我们等问候，双方干等到超时。
 * 抽成函数是为了让「提示里说的」和「实际连的」共用一套判定，不会各写一份改漏。
 */
export function isImplicitTls(port, secure) {
  return [465, 994].includes(Number(port)) ? true : secure !== 'starttls';
}

/** 错误信息里带上实际连接参数：用户不用猜「到底连的哪个端口、用的哪种加密」 */
export function describeCfg(cfg) {
  return `${cfg.host}:${Number(cfg.port)}（${isImplicitTls(cfg.port, cfg.secure) ? 'SSL / 隐式 TLS' : 'STARTTLS'}）`;
}

export async function sendMail(cfg, msg, connectFn, prog) {
  const timeoutMs = cfg.timeoutMs || 30000;
  const fail = (m) => ({ ok: false, error: m });
  if (!cfg.host || !cfg.port) return fail('SMTP 服务器地址或端口未配置');
  if (String(cfg.port) === '25') return fail('Cloudflare 禁止 25 端口，请改用 465（SSL）或 587（STARTTLS）');
  if (!cfg.user || !cfg.pass) return fail('发件邮箱或密码（授权码）未填写');
  if (!msg.to) return fail('收件人为空');
  if (typeof connectFn !== 'function') return fail('未拿到 cloudflare:sockets 的 connect（当前环境可能不支持 TCP 出站）');

  // 进度用外部对象记录：外层超时时要能说出「卡在哪一步」，
  // 否则用户只能看到一个笼统的「超时」，无从排查。
  const P = prog || { stage: '初始化', t0: Date.now(), at: Date.now() };
  const at = (s) => { P.stage = s; P.at = Date.now(); };

  let socket = null;
  try {
    const ssl = isImplicitTls(cfg.port, cfg.secure);
    at(`TCP/TLS 握手 ${cfg.host}:${cfg.port}（${ssl ? '465 隐式 SSL' : '587 STARTTLS'}）`);
    // ⚠️ connect(address, options) —— secureTransport 必须放在第二个参数 options 里。
    //    曾经把它塞进 address（第一个参数），Cloudflare 不认，结果就是明文去连 465：
    //    服务器等着 TLS 握手、我们等着 220 问候，双方干等到超时。
    //    本地假 socket 不校验参数位置，所以 72 个用例全没抓到，上线才暴露。
    socket = connectFn(
      { hostname: cfg.host, port: Number(cfg.port) },
      { secureTransport: ssl ? 'on' : 'starttls' },
    );
    // opened 在连接建立时 resolve、出错时 reject。
    // 不 await 的话连接失败要等到第一次 read 超时才被发现。
    if (socket && socket.opened) await socket.opened;

    let s = new Smtp(socket);
    at('读取服务器问候（220）');
    await s.cmd(null, [220]);

    if (!ssl) {
      // 587：先明文 EHLO，再 STARTTLS 升级，升级后必须重新 EHLO（服务器会丢弃升级前的状态）
      at('明文 EHLO');
      await s.cmd(`EHLO ${ehloOf(cfg)}`, [250]);
      at('STARTTLS 升级');
      await s.cmd('STARTTLS', [220]);
      const secure = socket.startTls();
      s = new Smtp(secure);
      socket = secure;
      if (secure && secure.opened) await secure.opened;
    }
    at('EHLO 握手');
    await s.cmd(`EHLO ${ehloOf(cfg)}`, [250]);

    // AUTH LOGIN：163 / QQ / Gmail 等均支持；按 base64 分两次提交
    at('登录认证（AUTH LOGIN）');
    await s.cmd('AUTH LOGIN', [334]);
    await s.cmd(b64(cfg.user), [334]);
    // 535 几乎都是「填了登录密码而不是授权码」，单独提示，省得查半天
    try {
      await s.cmd(b64(cfg.pass), [235]);
    } catch (ae) {
      const t = String((ae && ae.message) || '');
      if (t.includes('535')) throw new Error('535 认证失败：密码栏要填邮箱的「SMTP 授权码 / 客户端专用密码」，不是邮箱登录密码');
      throw ae;
    }

    at('声明发件人与收件人');
    await s.cmd(`MAIL FROM:<${cfg.from || cfg.user}>`, [250]);
    await s.cmd(`RCPT TO:<${msg.to}>`, [250, 251]);
    at('投递邮件内容（DATA）');
    await s.cmd('DATA', [354]);
    const raw = buildMime({ ...msg, from: cfg.from || cfg.user, fromName: cfg.fromName });
    await s.cmd(dotStuff(raw) + '\r\n.', [250]);
    try { await s.cmd('QUIT', [221, 250]); } catch (e) { /* 有些服务器直接断开，不影响发送结果 */ }
    await s.close();
    return { ok: true };
  } catch (e) {
    if (socket) { try { socket.close(); } catch (e2) { /* ignore */ } }
    let why = e && e.message ? e.message : String(e);
    // 连上了却没等到 220 就被断开：不是账号问题，是传输层就被拒，给出可核对的排查项
    if (/提前关闭/.test(why) && /问候/.test(P.stage)) {
      why += `。TCP 连得上但服务器立刻断开，说明它不接受这次连接：① 端口与加密方式不匹配（465/994 必须是 SSL，587 必须是 STARTTLS），本次实际是 ${describeCfg(cfg)}；② 服务商拒绝了 Cloudflare 的出站 IP —— Cloudflare 的出口 IP 每次可能不同，所以会时通时不通，可隔几分钟重试，或把端口换成 994 再试`;
    }
    return fail(`[${P.stage}] ${why}`);
  }
}

// EHLO 报的主机名：不能拿 SMTP 服务器自己的域名（如 smtp.163.com）当本机名，
// 服务器会认为客户端伪造身份，表现为延迟甚至直接断连。优先用站点域名，兜底 localhost。
function ehloOf(cfg) {
  const h = (cfg && cfg.ehlo) ? String(cfg.ehlo).trim() : '';
  return h || 'localhost';
}

// 超时只说「超时」没法排查，得按卡住的阶段给出最可能的原因
function timeoutHint(stage) {
  if (/握手|问候/.test(stage)) {
    return '最常见：① 该 SMTP 服务器拒绝 Cloudflare 的出站连接 —— Cloudflare 的 TCP 出站源 IP 不在其公布的 IP 段内，163/126/QQ 等国内邮箱常直接拒境外连接；② 端口与加密方式不匹配（465=SSL，587=STARTTLS）。建议先用 smtp.office365.com:587 或 smtp.gmail.com:465 试一次，确认通道本身通不通。';
  }
  if (/认证|登录/.test(stage)) return '连接已建立但认证没返回，多半是账号被限流，或需要用授权码 / 应用专用密码。';
  if (/投递|DATA/.test(stage)) return '认证已通过、卡在投递，通常是内容被扫描或邮件过大。';
  return '建议换端口或换服务商各试一次，并到 Cloudflare 控制台 → Workers & Pages → 你的项目 → Functions → 日志看完整堆栈。';
}

// 给整次发送套一个硬超时：握手卡住时不能把请求拖死
export async function sendMailWithTimeout(cfg, msg, connectFn) {
  const ms = cfg.timeoutMs || 30000;
  const prog = { stage: '初始化', t0: Date.now(), at: Date.now() };
  let timer = null;
  const guard = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(
      `连接或发送超时（${ms / 1000} 秒），卡在「${prog.stage}」。${timeoutHint(prog.stage)}`,
    )), ms);
  });
  try {
    return await Promise.race([sendMail(cfg, msg, connectFn, prog), guard]);
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------- 配置校验 ----------
// 从设置里组装发信配置；缺项直接给出可读错误，避免发出去才失败
export function mailConfigFrom(s) {
  const enabled = s.get('mail_enabled') === '1';
  const cfg = {
    enabled,
    onComment: s.get('mail_on_comment') === '1',
    onReply: s.get('mail_on_reply') === '1',
    provider: s.get('mail_provider') || '163',
    host: (s.get('mail_host') || '').trim(),
    port: parseInt(s.get('mail_port'), 10) || 465,
    secure: s.get('mail_secure') === 'starttls' ? 'starttls' : 'ssl',
    user: (s.get('mail_user') || '').trim(),
    pass: s.get('mail_pass') || '',
    fromName: (s.get('mail_from_name') || '').trim() || s.get('site_title') || '博客',
    template: ['card', 'plain', 'minimal'].includes(s.get('mail_template')) ? s.get('mail_template') : 'card',
    // 跨国 + TLS 握手 + 8 次命令往返，15 秒不够用，放到 30 秒
    timeoutMs: 30000,
    ehlo: ehloFromSiteUrl(s.get('site_url')),
  };
  return cfg;
}

// EHLO 报给服务器的本机名：用站点域名，取不到就 localhost
function ehloFromSiteUrl(u) {
  try {
    if (!u) return 'localhost';
    const h = new URL(String(u).trim()).hostname;
    return h || 'localhost';
  } catch (e) { return 'localhost'; }
}

export function mailConfigError(cfg) {
  if (!cfg.host) return 'SMTP 服务器地址未填写';
  if (String(cfg.port) === '25') return 'Cloudflare 禁止 25 端口，请改用 465（SSL）或 587（STARTTLS）';
  if (!/^\d{2,5}$/.test(String(cfg.port))) return '端口不合法';
  if (!cfg.user) return '发件邮箱未填写';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cfg.user)) return '发件邮箱格式不正确';
  if (!cfg.pass) return '密码 / 授权码未填写';
  return '';
}

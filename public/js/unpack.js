// ============================================================
// 压缩包解包（Ver 0.7 ②）：zip / tar / tar.gz / tgz，零依赖
//
// 为什么在浏览器里解：和 ① 的 SQL 解析同一条理由 —— Workers 免费版单请求
// CPU 只有约 10ms，几 MB 的压缩包交给服务端解必然超时；浏览器里解完只把
// 「文章文本 + 要上传的图片」按批送上去，服务端的工作量与包体积无关。
//
// 只用平台自带的 DecompressionStream，不引任何第三方库：
//   · zip 的 deflate  → 'deflate-raw'（注意不是 'deflate'，zip 没有 zlib 头）
//   · gzip / tgz      → 'gzip'
// 纯函数、不碰 DOM、不碰网络，Node 22 里也能直接跑（测试就是这么跑的）。
//
// 护栏（防 zip bomb 与误拖大包）：
//   · 条目数 ≤ 3000（附件包 5000）、解压后合计 ≤ 64MB（附件包 128MB）；
//   · 单个文件：图片 ≤ 8MB、音频 ≤ 20MB、视频 ≤ 80MB、其它（md / _comments.json）≤ 24MB；
//   · 只解我们认识的扩展名，其余条目连解都不解，所以一个塞满无关文件的包里
//     99% 的字节根本不会被展开。
//
// 体积分档**必须与服务端 MEDIA_MAX 对齐**（functions/_lib/util.js）。两处各定各的
// 会打架：解包放到 24MB、服务端只收 8MB，于是 8~24MB 的图能通过预览、在上传时才
// 吃 413，用户只看到「张数少了一张」，不知道是哪张、为什么。
// ============================================================

const MB = 1024 * 1024;

export const MAX_ENTRIES = 3000;
export const MAX_ENTRIES_ATTACH = 5000;
export const MAX_FILE_BYTES = 24 * MB;
export const MAX_IMAGE_BYTES = 8 * MB;
export const MAX_AUDIO_BYTES = 20 * MB;
export const MAX_VIDEO_BYTES = 80 * MB;
export const MAX_TOTAL_BYTES = 64 * MB;
// 附件包放宽到 128MB 并把条目放到 5000：一次搬几十张图的站很常见，
// 3000 条会误伤；上限仍然留着，免得误拖一个整站备份把标签页撑爆。
export const MAX_TOTAL_ATTACH = 128 * MB;

// 打包工具顺手塞进来的垃圾，一律跳过（Mac 的资源分支尤其烦，每个文件都带一份）
const JUNK_RE = /(^|\/)(__MACOSX|\.git|\.svn|node_modules|\.idea|\.vscode)\/|(^|\/)\.DS_Store$|(^|\/)Thumbs\.db$/i;
// 只解这些：正文、图片、以及本博客自己导出的评论 JSON
const WANT_RE = /\.(md|markdown|mdown|mkd)$|\.(png|jpe?g|gif|webp|avif|bmp)$|(^|\/)_comments\.json$/i;
// 附件包只收「服务端真的会收下的东西」。/api/media 的白名单里没有 pdf / docx /
// 压缩包，收进来也传不上去，只会让清单上的数字骗人 —— 这类文件留在正文里指向原站，
// 报告里单独报一句。
const ATTACH_RE = /\.(png|jpe?g|gif|webp|avif|bmp|ico|mp4|webm|mov|m4v|ogv|mp3|m4a|aac|wav|flac|ogg|opus|weba)$/i;
// 认识的图片扩展名 → MIME。/api/media 的白名单里没有 svg，这里也不认，避免上传时才失败。
const IMG_CT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp' };

export const IMAGE_TYPES = IMG_CT;
export const isImagePath = (p) => /\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(String(p || ''));
export const isMarkdownPath = (p) => /\.(md|markdown|mdown|mkd)$/i.test(String(p || ''));
export const isMediaPath = (p) => ATTACH_RE.test(String(p || ''));

// 按扩展名定「这是哪一类媒体」，决定用哪一档体积上限。
// 认不出就返回空串 —— 调用方会退回「普通文件 24MB」那条规则。
export function mediaKindOfPath(p) {
  const m = /\.([a-z0-9]+)$/i.exec(String(p || ''));
  const ext = m ? m[1].toLowerCase() : '';
  if (IMAGE_TYPES[ext] || ext === 'ico') return 'image';
  if (['mp4', 'webm', 'mov', 'm4v', 'ogv'].includes(ext)) return 'video';
  if (['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', 'weba'].includes(ext)) return 'audio';
  return '';
}

export const MEDIA_LIMITS = { image: MAX_IMAGE_BYTES, audio: MAX_AUDIO_BYTES, video: MAX_VIDEO_BYTES };

// 扩展名 → 上传时要发给服务端的 MIME。发送时若类型不对，/api/media 会直接 415。
const EXT_CT = {
  ...IMG_CT,
  ico: 'image/x-icon',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/x-m4v', ogv: 'video/ogg',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav',
  flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/opus', weba: 'audio/webm',
};
export function mediaMime(p) {
  const m = /\.([a-z0-9]+)$/i.exec(String(p || ''));
  return (m && EXT_CT[m[1].toLowerCase()]) || '';
}

export function imageMime(p) {
  const m = /\.([a-z0-9]+)$/i.exec(String(p || ''));
  return (m && IMG_CT[m[1].toLowerCase()]) || '';
}

const hasDS = () => typeof DecompressionStream !== 'undefined';
const u16 = (b, i) => b[i] | (b[i + 1] << 8);
const u32 = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;

// ZIP 里的文件名没有强制编码：带 0x800 标志的是 UTF-8，Windows 中文环境打的包
// 多半是 GBK 裸字节。先按 UTF-8 严格解，解不动再退 GBK —— 直接按 UTF-8 解会得到
// 一屏「锟斤拷」，图片就按名字对不上了。
export function decodeName(bytes, utf8Flag) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (utf8Flag) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(arr); } catch (e) { /* 落到下面 */ }
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(arr); } catch (e) { /* 不是 UTF-8 */ }
  try { return new TextDecoder('gbk').decode(arr); } catch (e) { /* 环境不支持 GBK */ }
  let s = '';
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return s;
}

export function normalizePath(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+/, '');
}

async function inflate(bytes, fmt) {
  if (!hasDS()) throw new Error('当前浏览器不支持解压（需要较新的 Chrome / Edge / Safari），请换浏览器再试');
  const ds = new DecompressionStream(fmt);
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export const inflateRaw = (b) => inflate(b, 'deflate-raw');
export const inflateGzip = (b) => inflate(b, 'gzip');

// ------------------------------------------------------------
// 格式判断：优先看魔数，其次看扩展名（.md 这种纯文本没有魔数）
// ------------------------------------------------------------
export function sniff(bytes, name) {
  const n = String(name || '').toLowerCase();
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    if (bytes[2] === 3 || bytes[2] === 5 || bytes[2] === 7) return 'zip';
  }
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) return 'gzip';
  if (bytes.length >= 262) {
    let magic = '';
    for (let i = 257; i < 262; i++) magic += String.fromCharCode(bytes[i]);
    if (magic === 'ustar') return 'tar';
  }
  if (/\.(md|markdown|mdown|mkd)$/.test(n)) return 'markdown';
  if (/\.(zip|tar|tgz|gz)$/.test(n)) return 'unknown'; // 扩展名像压缩包、内容却不是
  return 'unknown';
}

function emptyResult(kind) {
  // tooLargeImages：被体积上限拦下的图片张数。单独计数而不是让调用方去数 skipped ——
  // skipped 有条数上限（200），图多的时候数出来会偏小，清单上就少报了。
  // bigPaths：这些图的包内路径，给 mdplan 用（区分「包里有但太大」与「包里没有」）。
  // tooLargeMedia：图片 + 视频 + 音频的合计，附件包用这个数。
  return { kind, files: [], skipped: [], bytes: 0, tooLargeImages: 0, tooLargeMedia: 0, bigPaths: [] };
}

function pushFile(out, path, bytes, maxTotal) {
  out.files.push({ path, bytes, size: bytes.length });
  out.bytes += bytes.length;
  const cap = maxTotal || MAX_TOTAL_BYTES;
  if (out.bytes > cap) {
    throw new Error(`解压后的内容合计超过 ${Math.round(cap / MB)}MB 上限，请分批打包再导`);
  }
}

// code 是给界面用的机器可读原因：文案会改，判断逻辑不能跟着改。
function noteSkip(out, path, why, code) {
  if (out.skipped.length < 200) out.skipped.push({ path, why, code: code || 'other' });
}

// 单文件体积检查：图片 8MB / 音频 20MB / 视频 80MB，其余（md 等）24MB。
// 返回 true 表示已跳过。
function sizeSkip(out, path, size) {
  const kind = mediaKindOfPath(path);
  const max = kind ? MEDIA_LIMITS[kind] : MAX_FILE_BYTES;
  if (size <= max) return false;
  const mb = Math.round(max / MB);
  if (kind === 'image') { out.tooLargeImages++; out.bigPaths.push(path); }
  if (kind) out.tooLargeMedia++;
  const label = kind === 'image' ? '图片' : kind === 'video' ? '视频' : kind === 'audio' ? '音频' : '单个文件';
  noteSkip(out, path, `${label}超过 ${mb}MB`, kind === 'image' ? 'image-too-large' : kind ? 'media-too-large' : 'too-large');
  return true;
}

// 解压前/后检查一次即可，但两条都要有：解压前看的是包里声明的大小（能省一次解压），
// 解压后看的是真实大小（声明值可以被伪造，zip bomb 就靠这个）。

// ------------------------------------------------------------
// ZIP：中央目录里拿「真实大小 + 本地头偏移」，再从本地头算出数据起点。
// 只信中央目录的尺寸，不信本地头 —— 带 data descriptor（标志位 3）的包，
// 本地头里的 size 是 0，照它读会读出一个空文件来。
// ------------------------------------------------------------
export async function unzip(bytes, opts = {}) {
  const out = emptyResult('zip');
  const b = bytes;
  const maxEntries = Number(opts.maxEntries) || MAX_ENTRIES;
  const maxTotal = Number(opts.maxTotal) || MAX_TOTAL_BYTES;
  let eocd = -1;
  const min = Math.max(0, b.length - 65557);
  for (let i = b.length - 22; i >= min; i--) {
    if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 0x05 && b[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('这不是一个完整的 zip 文件（找不到目录区），可能下载不完整或被改过后缀');

  const total = u16(b, eocd + 10);
  const cdSize = u32(b, eocd + 12);
  const cdOff = u32(b, eocd + 16);
  if (total === 0xffff || cdOff === 0xffffffff || cdSize === 0xffffffff) {
    throw new Error('这个 zip 是 ZIP64 格式（一般是超过 4GB 的大包），浏览器里不支持，请拆分后再导');
  }
  if (total > maxEntries) {
    throw new Error(`压缩包里有多达 ${total} 个文件，超过 ${maxEntries} 个上限，请只保留要导入的内容再打包`);
  }
  if (cdOff + cdSize > b.length) throw new Error('zip 的目录区越界了，文件可能已损坏');

  let p = cdOff;
  let seen = 0;
  while (p + 46 <= b.length && seen < total && u32(b, p) === 0x02014b50) {
    seen++;
    const flags = u16(b, p + 8);
    const method = u16(b, p + 10);
    const compSize = u32(b, p + 20);
    const rawSize = u32(b, p + 24);
    const nameLen = u16(b, p + 28);
    const extraLen = u16(b, p + 30);
    const cmtLen = u16(b, p + 32);
    const localOff = u32(b, p + 42);
    const name = normalizePath(decodeName(b.subarray(p + 46, p + 46 + nameLen), (flags & 0x800) !== 0));
    p += 46 + nameLen + extraLen + cmtLen;

    if (!name || name.endsWith('/')) continue;
    if (JUNK_RE.test(name)) { noteSkip(out, name, '系统垃圾文件'); continue; }
    const accept = typeof opts.accept === 'function' ? opts.accept : (x) => WANT_RE.test(x);
    if (!accept(name)) { noteSkip(out, name, '不是文章或图片'); continue; }
    if (flags & 1) { noteSkip(out, name, '文件被加密'); continue; }
    if (compSize === 0xffffffff || rawSize === 0xffffffff || localOff === 0xffffffff) {
      noteSkip(out, name, 'ZIP64 条目');
      continue;
    }
    if (sizeSkip(out, name, rawSize)) continue;
    if (localOff + 30 > b.length) { noteSkip(out, name, '本地头越界'); continue; }
    if (u32(b, localOff) !== 0x04034b50) { noteSkip(out, name, '本地头损坏'); continue; }

    const lNameLen = u16(b, localOff + 26);
    const lExtraLen = u16(b, localOff + 28);
    const dataOff = localOff + 30 + lNameLen + lExtraLen;
    if (dataOff + compSize > b.length) { noteSkip(out, name, '数据区越界'); continue; }
    const raw = b.subarray(dataOff, dataOff + compSize);

    let data;
    try {
      if (method === 0) data = raw;
      else if (method === 8) data = await inflateRaw(raw);
      else { noteSkip(out, name, '压缩方式不支持（只用 store / deflate）'); continue; }
    } catch (e) {
      noteSkip(out, name, '解压失败：' + e.message);
      continue;
    }
    if (sizeSkip(out, name, data.length)) continue;
    pushFile(out, name, data, maxTotal);
  }
  if (!seen) throw new Error('zip 的目录区里一条记录都没有，文件可能已损坏');
  return out;
}

// ------------------------------------------------------------
// TAR：512 字节一块的头 + 按 512 对齐的数据区。ustar 的 prefix 字段
// 存的是长路径的前半段，不拼回来会丢掉上层目录（图片就找不到了）。
// ------------------------------------------------------------
function cstr(b, start, len) {
  let end = start;
  const stop = start + len;
  while (end < stop && b[end] !== 0) end++;
  let s = '';
  for (let i = start; i < end; i++) s += String.fromCharCode(b[i]);
  return s;
}

function tarSize(b, i) {
  if (b[i] & 0x80) { // GNU base-256：高位置 1，剩下的是大端整数
    let v = 0;
    for (let k = i + 1; k < i + 12; k++) v = v * 256 + b[k];
    return v;
  }
  const s = cstr(b, i, 12).trim();
  return s ? parseInt(s, 8) || 0 : 0;
}

export async function untar(bytes, opts = {}) {
  const out = emptyResult('tar');
  const b = bytes;
  const maxEntries = Number(opts.maxEntries) || MAX_ENTRIES;
  const maxTotal = Number(opts.maxTotal) || MAX_TOTAL_BYTES;
  const accept = typeof opts.accept === 'function' ? opts.accept : (x) => WANT_RE.test(x);
  let p = 0;
  let longName = '';
  let paxPath = '';
  let guard = 0;
  let count = 0;
  while (p + 512 <= b.length) {
    if (++guard > maxEntries * 2) throw new Error('tar 里的条目太多，已经超过处理上限');
    let zero = true;
    for (let i = p; i < p + 512; i++) { if (b[i]) { zero = false; break; } }
    if (zero) break; // 结尾的两块全零

    let name = cstr(b, p, 100);
    const prefix = cstr(b, p + 345, 155);
    if (prefix) name = prefix + '/' + name;
    const size = tarSize(b, p + 124);
    const type = String.fromCharCode(b[p + 156] || 48);
    const dataOff = p + 512;
    const dataLen = Math.min(size, Math.max(0, b.length - dataOff));
    const next = dataOff + Math.ceil(size / 512) * 512;

    // GNU 长文件名：真名在下一块的数据里；PAX 头同理，形如 `12 path=xxx\n`
    if (type === 'L') {
      longName = cstr(b, dataOff, Math.min(dataLen, 4096)).replace(/\0+$/, '');
      p = next;
      continue;
    }
    if (type === 'x' || type === 'X') {
      const txt = cstr(b, dataOff, Math.min(dataLen, 8192));
      const m = /\bpath=([^\n]*)\n/.exec(txt);
      if (m) paxPath = m[1];
      p = next;
      continue;
    }
    if (longName) { name = longName; longName = ''; }
    if (paxPath) { name = paxPath; paxPath = ''; }

    if (!name || name.endsWith('/') || type === '5') { p = next; continue; }
    if (type !== '0' && type !== '\0' && type !== '7') { p = next; continue; } // 链接、设备文件一律不认
    // 目录与特殊条目不算「文件」，所以计数放在这里；guard 只是防止死循环的粗上限，
    // 真正对外的口径是 maxEntries —— 附件包放到 5000 就是这一条在生效。
    if (++count > maxEntries) throw new Error(`压缩包里的文件超过 ${maxEntries} 个上限，请分批打包再导`);

    const clean = normalizePath(name);
    if (JUNK_RE.test(clean)) { noteSkip(out, clean, '系统垃圾文件'); p = next; continue; }
    if (!accept(clean)) { noteSkip(out, clean, '不是文章或图片'); p = next; continue; }
    if (sizeSkip(out, clean, size)) { p = next; continue; }
    pushFile(out, clean, b.subarray(dataOff, dataOff + dataLen), maxTotal);
    p = next;
  }
  if (!out.files.length && !out.skipped.length) throw new Error('tar 里没有读到任何文件，可能不是 tar 格式');
  return out;
}

// ------------------------------------------------------------
// 统一入口：字节 + 文件名 → 文件清单
// ------------------------------------------------------------
export async function unpack(bytes, name, opts = {}) {
  const kind = sniff(bytes, name || '');
  if (kind === 'zip') return unzip(bytes, opts);
  if (kind === 'tar') return untar(bytes, opts);

  if (kind === 'gzip') {
    let inner;
    try { inner = await inflateGzip(bytes); } catch (e) { throw new Error('gzip 解压失败：' + e.message); }
    // .tar.gz 与 .tgz 解出来是 tar；单个 .md.gz 解出来就是正文本身
    if (inner.length >= 262) {
      let magic = '';
      for (let i = 257; i < 262; i++) magic += String.fromCharCode(inner[i]);
      if (magic === 'ustar') return untar(inner, opts);
    }
    const out = emptyResult('gzip');
    const base = String(name || 'archive').replace(/\.(tar\.)?(gz|tgz)$/i, '') || 'import.md';
    const fileName = /\.(md|markdown|mdown|mkd)$/i.test(base) ? base : base + '.md';
    pushFile(out, normalizePath(fileName), inner);
    return out;
  }

  if (kind === 'markdown') {
    const out = emptyResult('markdown');
    pushFile(out, normalizePath(String(name || 'import.md')), bytes);
    return out;
  }

  throw new Error('认不出这个文件：支持 .zip / .tar / .tar.gz / .tgz，或单个 .md 文件。7z、rar 请先转成 zip');
}

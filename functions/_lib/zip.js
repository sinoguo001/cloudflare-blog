// 极简 ZIP 打包器 —— 零依赖，只为「导出静态站点」这一件事服务。
//
// 为什么自己写而不是引库：Pages Functions 里没有可用的 zip 依赖，而这个格式
// 本身只有三段固定结构（本地文件头 / 中央目录 / 尾记录），几十行就能出对的产物。
//
// 支持：stored(0) 与 deflate(8) 两种压缩方法、UTF-8 文件名（general purpose flag bit 11）。
// 不支持 ZIP64：条目数远到不了 65535、单文件也远到不了 4GB，越过阈值直接抛错 ——
// 宁可当场报错，也不要产出一个「看着像 zip、其实打不开」的文件。

const _crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

// 标准 CRC-32（反射多项式 0xEDB88320），ZIP 每个条目都必须带。
// 注意 Int32Array 读出来是**有符号**的，循环里 c 会是负数 —— 位运算本身按二进制走、
// 结果正确，但返回前必须 `>>> 0` 修正，否则 DataView.setUint32 会写成一个巨大的负数。
export function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = _crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

const concat = (parts) => {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

// ⚠️ ZIP 里没有「时区」这个概念，时间戳就得挑一个明确的基准。
// 这里一律用 **UTC 的 getUTC*** —— Worker 运行时本来就没有本地时区，
// 用 getHours() 在本地与线上会得到不同数字，测试也没法复现。
function dosStamp(d) {
  const y = Math.max(1980, d.getUTCFullYear());
  return {
    time: ((d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1)) & 0xFFFF,
    date: (((y - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate()) & 0xFFFF,
  };
}

// deflate-raw 就是 ZIP 的 method 8 要的载荷（裸 deflate，不带 zlib 头）。
// 环境没有 CompressionStream 时返回 null，由调用方回落成 stored —— 不抛错，
// 保证「打包」这件事在任何环境下都能产出可解压的文件。
async function deflateRaw(bytes) {
  if (typeof CompressionStream !== 'function') return null;
  try {
    const cs = new CompressionStream('deflate-raw');
    // 读和写必须**并发**：先 write 完再读，大文件会在内部背压处死等。
    const collecting = (async () => {
      const chunks = [];
      const rd = cs.readable.getReader();
      for (;;) {
        const step = await rd.read();
        if (step.done) break;
        chunks.push(step.value);
      }
      return concat(chunks);
    })();
    const w = cs.writable.getWriter();
    await w.write(bytes);
    await w.close();
    return await collecting;
  } catch (e) { return null; }
}

/**
 * 把一组文件打成 ZIP。
 * @param {{name:string, data:Uint8Array|string}[]} files
 * @param {{mtime?:Date, compress?:boolean}} [opts]
 * @returns {Promise<Uint8Array>}
 */
export async function makeZip(files, opts = {}) {
  const at = opts.mtime instanceof Date ? opts.mtime : new Date();
  const compress = opts.compress !== false;
  const stamp = dosStamp(at);
  const enc = new TextEncoder();
  const parts = [];
  const centrals = [];
  const seen = new Set();
  let offset = 0;

  for (const f of files) {
    const name = String(f.name || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!name) throw new Error('ZIP 条目缺少文件名');
    if (/(^|\/)\.\.(\/|$)/.test(name)) throw new Error('ZIP 条目名不允许跳出上级目录：' + name);
    // 同名条目在解压时会互相覆盖，属于静默丢数据 —— 宁可当场炸
    if (seen.has(name)) throw new Error('ZIP 里出现重名条目：' + name);
    seen.add(name);

    const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    if (!data || typeof data.length !== 'number') throw new Error('ZIP 条目内容必须是字符串或 TypedArray：' + name);
    if (data.length > 0xFFFFFFFF) throw new Error('单个文件超过 4GB，本打包器不支持 ZIP64：' + name);

    let method = 0;
    let body = data;
    // 空文件没什么可压的；压完比原文还大（小文件常态）也老实存原文。
    if (compress && data.length) {
      const z = await deflateRaw(data);
      if (z && z.length < data.length) { method = 8; body = z; }
    }

    const nameBuf = enc.encode(name);
    const lh = new Uint8Array(30 + nameBuf.length);
    const dv = new DataView(lh.buffer);
    dv.setUint32(0, 0x04034B50, true);          // 本地文件头签名
    dv.setUint16(4, 20, true);                  // 解压所需版本 2.0
    dv.setUint16(6, 0x0800, true);              // bit 11：文件名按 UTF-8 存
    dv.setUint16(8, method, true);
    dv.setUint16(10, stamp.time, true);
    dv.setUint16(12, stamp.date, true);
    dv.setUint32(14, crc32(data), true);
    dv.setUint32(18, body.length, true);        // 压缩后长度
    dv.setUint32(22, data.length, true);        // 原始长度
    dv.setUint16(26, nameBuf.length, true);
    dv.setUint16(28, 0, true);                  // 额外字段长度
    lh.set(nameBuf, 30);

    const ch = new Uint8Array(46 + nameBuf.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014B50, true);          // 中央目录签名
    cv.setUint16(4, 20, true);                  // 制作版本
    cv.setUint16(6, 20, true);                  // 解压所需版本
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, stamp.time, true);
    cv.setUint16(14, stamp.date, true);
    cv.setUint32(16, crc32(data), true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBuf.length, true);
    cv.setUint16(30, 0, true);                  // 额外字段
    cv.setUint16(32, 0, true);                  // 注释
    cv.setUint16(34, 0, true);                  // 起始磁盘号
    cv.setUint16(36, 0, true);                  // 内部属性
    // 外部属性：低 16 位是 DOS 属性，高 16 位是 Unix 权限（0o100644 = 普通文件 rw-r--r--）。
    // ⚠️ 0o100644 << 16 在 JS 里会溢出成负数（32 位有符号），乘出来再 >>> 0 才对。
    cv.setUint32(38, (0o100644 * 0x10000) >>> 0, true);
    cv.setUint32(42, offset, true);             // 本地文件头相对偏移
    ch.set(nameBuf, 46);

    parts.push(lh, body);
    centrals.push(ch);
    offset += lh.length + body.length;
  }

  if (seen.size > 0xFFFF) throw new Error('条目数超过 65535，本打包器不支持 ZIP64');

  const cdOffset = offset;
  const cd = concat(centrals);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054B50, true);            // 尾记录签名
  ev.setUint16(4, 0, true);                     // 本磁盘号
  ev.setUint16(6, 0, true);                     // 中央目录所在磁盘号
  ev.setUint16(8, seen.size, true);
  ev.setUint16(10, seen.size, true);
  ev.setUint32(12, cd.length, true);
  ev.setUint32(16, cdOffset, true);
  ev.setUint16(20, 0, true);                    // 注释长度

  return concat([...parts, cd, eocd]);
}

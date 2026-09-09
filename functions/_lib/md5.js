// ============================================================
// MD5（纯 JS，Worker 端专用）
// 用途：Gravatar 头像地址需要对「去空格+小写」的邮箱做 MD5。
// 注意：Cloudflare Workers 的 WebCrypto (crypto.subtle) 不支持 MD5，
//       只支持 SHA-1/SHA-256 等，因此这里自带一份精简实现。
// 支持 UTF-8 中文等多字节字符。
// ============================================================

function toUtf8Bytes(str) {
  const s = unescape(encodeURIComponent(String(str)));
  const out = new Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function md5Bytes(bytes) {
  const K = [
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
    0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
    0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
    0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
    0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
    0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
    0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
    0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
  ];
  const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;

  const len = bytes.length;
  const withPad = bytes.slice();
  withPad.push(0x80);
  while (withPad.length % 64 !== 56) withPad.push(0);
  // 追加 64 位长度（小端）。JS 的移位位数按 32 取模，所以这里用除法逐字节取，
  // 不能写 (bitLen >>> (i*8)) —— i>=4 时会把低位字节重复写进高 4 字节。
  let bl = len * 8;
  for (let i = 0; i < 8; i++) { withPad.push(bl % 256); bl = Math.floor(bl / 256); }

  const rotl = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0;
  const cmn = (q, a, b, x, s, t) => rotl(((a + q + x + t) >>> 0) | 0, s) + b >>> 0;

  for (let off = 0; off < withPad.length; off += 64) {
    const M = [];
    for (let j = 0; j < 16; j++) {
      M[j] = (withPad[off + j * 4]) | (withPad[off + j * 4 + 1] << 8) |
        (withPad[off + j * 4 + 2] << 16) | (withPad[off + j * 4 + 3] << 24);
    }
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; } else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; } else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; } else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = F >>> 0;
      const tmp = D;
      D = C; C = B;
      B = (B + rotl((A + F + K[i] + M[g]) >>> 0, S[i])) >>> 0;
      A = tmp;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }

  const hex = (n) => (n >>> 0).toString(16).padStart(8, '0');
  // 按小端序输出
  const out = [a0, b0, c0, d0].map((n) => hex(n).match(/../g).reverse().join('')).join('');
  return out;
}

export function md5(str) {
  return md5Bytes(toUtf8Bytes(str));
}

// Gravatar 规范：去首尾空格 + 转小写后取 MD5
export function gravatarHash(email) {
  return md5(String(email || '').trim().toLowerCase());
}

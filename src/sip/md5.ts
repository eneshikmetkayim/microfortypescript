/**
 * MD5 (RFC 1321) — port of the digest primitive MicroSIP uses through
 * pjlib (`pj_md5_init/update/final`, lib/MSIP.cpp:32 `msip_md5sum`).
 *
 * Kept dependency free so the SIP stack has no runtime libraries.
 */

const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
] as const;

const K = new Uint32Array(64);
for (let i = 0; i < 64; i++) {
  K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;
}

function rotl(x: number, c: number): number {
  return ((x << c) | (x >>> (32 - c))) >>> 0;
}

export function utf8(input: string): Uint8Array {
  return new TextEncoder().encode(input);
}

export function md5Bytes(input: Uint8Array): Uint8Array {
  const bitLen = input.length * 8;
  const paddedLength = (((input.length + 8) >> 6) + 1) << 6;
  const buffer = new Uint8Array(paddedLength);
  buffer.set(input);
  buffer[input.length] = 0x80;

  const view = new DataView(buffer.buffer);
  // 64-bit little endian length; JS numbers are safe for our payload sizes.
  view.setUint32(paddedLength - 8, bitLen >>> 0, true);
  view.setUint32(paddedLength - 4, Math.floor(bitLen / 0x100000000), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const m = new Uint32Array(16);
  for (let off = 0; off < paddedLength; off += 64) {
    for (let i = 0; i < 16; i++) m[i] = view.getUint32(off + i * 4, true);

    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const tmp = d;
      d = c;
      c = b;
      const sum = (a + f + (K[i] as number) + (m[g] as number)) >>> 0;
      b = (b + rotl(sum, S[i] as number)) >>> 0;
      a = tmp;
    }

    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, a0, true);
  outView.setUint32(4, b0, true);
  outView.setUint32(8, c0, true);
  outView.setUint32(12, d0, true);
  return out;
}

export function md5Hex(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? utf8(input) : input;
  let hex = "";
  for (const byte of md5Bytes(bytes)) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** MicroSIP `msip_md5sum()`: md5 of the UTF-8 encoded password, lowercase hex. */
export function msipMd5sum(password: string): string {
  return md5Hex(password);
}

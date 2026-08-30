/* Generates flat PNG icons (green ground + white download glyph) with no
 * dependencies, so the extension works in Chrome too (Chrome rejects SVG icons). */
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
})();

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(CRC(td));
  return Buffer.concat([len, td, crc]);
}

function png(size) {
  const s = size;
  const px = new Uint8Array(s * s * 4);
  const set = (x, y, r, g, b, a) => {
    if (x < 0 || y < 0 || x >= s || y >= s) return;
    const i = (y * s + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
  };
  // ground
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) set(x, y, 0x10, 0xa3, 0x7f, 0xff);
  // glyph: down arrow + underline, in white
  const W = (x, y) => set(x, y, 0xff, 0xff, 0xff, 0xff);
  const barX0 = Math.round(s * 0.44), barX1 = Math.round(s * 0.56);
  const barY0 = Math.round(s * 0.18), barY1 = Math.round(s * 0.52);
  for (let y = barY0; y < barY1; y++) for (let x = barX0; x < barX1; x++) W(x, y);
  const headTop = Math.round(s * 0.44), headBot = Math.round(s * 0.7);
  const cx = s / 2;
  for (let y = headTop; y < headBot; y++) {
    const hw = ((headBot - y) / (headBot - headTop)) * s * 0.24;
    for (let x = Math.round(cx - hw); x < Math.round(cx + hw); x++) W(x, y);
  }
  const ulY0 = Math.round(s * 0.78), ulY1 = Math.round(s * 0.88);
  const ulX0 = Math.round(s * 0.24), ulX1 = Math.round(s * 0.76);
  for (let y = ulY0; y < ulY1; y++) for (let x = ulX0; x < ulX1; x++) W(x, y);

  const raw = Buffer.alloc(s * (s * 4 + 1));
  for (let y = 0; y < s; y++) {
    raw[y * (s * 4 + 1)] = 0; // filter: none
    px.subarray(y * s * 4, (y + 1) * s * 4).forEach((v, i) => (raw[y * (s * 4 + 1) + 1 + i] = v));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(s, 0);
  ihdr.writeUInt32BE(s, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync(new URL("../icons/", import.meta.url), { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const out = new URL(`../icons/icon-${size}.png`, import.meta.url);
  writeFileSync(out, png(size));
  console.log("wrote", out.pathname);
}

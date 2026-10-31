// Render the HailBrowser icon (the website mark: ink tile + lime bolt) to PNGs. No dependencies.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

// Bolt polygon in a 0..1 box: the path of website/public/brand/mark.svg (32x32 viewBox).
const BOLT = [[18.4, 4.2], [8.6, 18.1], [13.8, 18.1], [12.7, 27.8], [22.8, 13.6], [17.4, 13.6], [18.4, 4.2]].map(([x, y]) => [x / 32, y / 32]);
const inside = (x, y, poly) => {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
};

function render(size) {
  const S = 4; // supersampling
  const rows = [];
  const r = 0.25; // corner radius (rx 8 of 32)
  for (let py = 0; py < size; py++) {
    const row = [0];
    for (let px = 0; px < size; px++) {
      let R = 0, G = 0, B = 0, A = 0;
      for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
        const x = (px + (sx + 0.5) / S) / size, y = (py + (sy + 0.5) / S) / size;
        const dx = Math.max(r - x, 0, x - (1 - r)), dy = Math.max(r - y, 0, y - (1 - r));
        if (dx * dx + dy * dy > r * r) continue;
        let c = [20, 19, 15]; // ink #14130f
        if (inside(x, y, BOLT)) c = [200, 247, 81]; // lime #c8f751
        R += c[0]; G += c[1]; B += c[2]; A += 255;
      }
      const n = S * S, a = A / n;
      row.push(...(a ? [R / (A / 255), G / (A / 255), B / (A / 255)].map(Math.round) : [0, 0, 0]), Math.round(a));
    }
    rows.push(Buffer.from(row));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

for (const size of [16, 32, 48, 128]) writeFileSync(new URL(`../extension/icons/icon${size}.png`, import.meta.url), render(size));
writeFileSync(new URL('../docs/logo.png', import.meta.url), render(256));
console.log('icons written');

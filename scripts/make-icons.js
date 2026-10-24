// Draws the Browzie icon (Claude's cursor arrow) as PNGs with no dependencies:
// supersampled point-in-polygon rasterising, then zlib + CRC for the PNG container.
//   node scripts/make-icons.js
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'icons');
fs.mkdirSync(out, { recursive: true });

// classic arrow cursor, tip at (0,0), in units of a 20 x 20 box
const ARROW = [[0, 0], [0, 17], [4.2, 13.2], [7.2, 20], [10, 18.8], [7.1, 12.2], [12.5, 12.2]];
const PURPLE = [124, 58, 237];

function inside(poly, x, y) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
function segDist(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function edgeDist(poly, x, y) {
  let d = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) d = Math.min(d, segDist(x, y, poly[j], poly[i]));
  return d;
}

function render(size) {
  const scale = (size * 0.86) / 20;
  const ox = size * 0.2;
  const oy = size * 0.06;
  const poly = ARROW.map(([x, y]) => [ox + x * scale, oy + y * scale]);
  const outline = Math.max(0.9, size / 42);
  const px = Buffer.alloc(size * size * 4);
  const N = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let fill = 0;
      let edge = 0;
      for (let sy = 0; sy < N; sy++) {
        for (let sx = 0; sx < N; sx++) {
          const fx = x + (sx + 0.5) / N;
          const fy = y + (sy + 0.5) / N;
          const d = edgeDist(poly, fx, fy);
          if (inside(poly, fx, fy)) d < outline ? edge++ : fill++;
          else if (d < outline * 0.6) edge++;
        }
      }
      const a = (fill + edge) / (N * N);
      if (!a) continue;
      const w = edge / (fill + edge);
      const i = (y * size + x) * 4;
      px[i] = Math.round(PURPLE[0] * (1 - w) + 255 * w);
      px[i + 1] = Math.round(PURPLE[1] * (1 - w) + 255 * w);
      px[i + 2] = Math.round(PURPLE[2] * (1 - w) + 255 * w);
      px[i + 3] = Math.round(255 * a);
    }
  }
  return png(size, size, px);
}

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

for (const s of [16, 32, 48, 128]) fs.writeFileSync(path.join(out, `icon${s}.png`), render(s));
console.log('icons written to', out);

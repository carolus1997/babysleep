// Genera los iconos PNG de la PWA (una luna creciente sobre fondo índigo) sin dependencias.
// Uso: node tools/make-icons.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

function png(size, { maskable }) {
  const bg = [79, 70, 229];
  const moon = [255, 244, 214];
  const scale = maskable ? 0.62 : 0.78; // zona segura mayor en los maskable
  const cx = size / 2;
  const cy = size / 2;
  const r = (size / 2) * scale * 0.9;
  const ox = r * 0.42; // desplazamiento del círculo que "muerde" la luna
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const inMoon = dx * dx + dy * dy <= r * r;
      const bite = (dx - ox) ** 2 + (dy + ox * 0.15) ** 2 <= (r * 0.82) ** 2;
      // fondo con degradado suave
      const t = (x + y) / (2 * size);
      const base = bg.map((v, i) => Math.round(v * (1 - 0.25 * t) + [30, 27, 120][i] * 0.25 * t));
      const c = inMoon && !bite ? moon : base;
      row.set([...c, 255], 1 + x * 4);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = new URL('../apps/mobile/public/', import.meta.url);
mkdirSync(out, { recursive: true });
writeFileSync(new URL('icon-192.png', out), png(192, { maskable: false }));
writeFileSync(new URL('icon-512.png', out), png(512, { maskable: false }));
writeFileSync(new URL('icon-maskable-512.png', out), png(512, { maskable: true }));
writeFileSync(new URL('apple-touch-icon.png', out), png(180, { maskable: false }));
console.log('iconos escritos en apps/mobile/public');

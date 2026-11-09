/**
 * Genera los iconos PNG de la PWA a partir de apps/mobile/public/icon.svg (única fuente del logo: anillo de sueño
 * con la luna dentro). Uso: node tools/make-icons.mjs
 * El SVG va a sangre y el sistema aplica la máscara (redondeada o circular). Como todo el dibujo cabe en el 80 %
 * central, el mismo arte sirve para el icono normal y para el «maskable» de Android.
 * Usa Playwright (ya es dependencia de desarrollo) para rasterizar.
 */
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const pub = resolve('apps/mobile/public');
const svg = readFileSync(resolve(pub, 'icon.svg'), 'utf8').replace(/ width="512" height="512"/, '');
const OUT = [
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['icon-maskable-512.png', 512],
  ['apple-touch-icon.png', 180],
];

const browser = await chromium.launch();
const page = await browser.newPage();
for (const [file, size] of OUT) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
  await page.screenshot({ path: resolve(pub, file), clip: { x: 0, y: 0, width: size, height: size } });
  console.log('✓', file, `${size}×${size}`);
}
await browser.close();

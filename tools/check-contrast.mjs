// Valida los pares de color del sistema de diseño (docs/design/BABYSLEEP_DESIGN_SYSTEM.md).
// Texto normal ≥ 4.5, texto grande/componentes ≥ 3 (WCAG 1.4.3 / 1.4.11).
const lum = (h) => {
  const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
export const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
// Los colores se leen de index.css: así el script no puede quedar desfasado respecto a la app.
import { readFileSync } from 'node:fs';
const css = readFileSync(new URL('../apps/mobile/src/index.css', import.meta.url), 'utf8');
const block = (theme) => {
  const start = css.indexOf(`[data-theme='${theme}']`);
  if (start < 0) throw new Error(`No se encuentra el tema ${theme} en index.css`);
  const body = css.slice(css.indexOf('{', start), css.indexOf('}', start));
  const v = (n) => {
    const hex = body.match(new RegExp(`--${n}:\\s*(#[0-9a-fA-F]{6})`))?.[1];
    if (!hex) throw new Error(`Falta --${n} en el tema ${theme}`);
    return hex;
  };
  const map = { bg: 'bg', s1: 'surface', s2: 'surface2', fg: 'fg', mu: 'muted', ac: 'accent', acfg: 'accent-fg', nap: 'seg-nap', nt: 'seg-night', ok: 'ok', danger: 'danger' };
  return Object.fromEntries(Object.entries(map).map(([k, n]) => [k, v(n)]));
};
export const THEMES = { light: block('light'), dark: block('dark'), night: block('night') };
const CHECKS = [['fg', 'bg', 4.5], ['fg', 's1', 4.5], ['mu', 'bg', 4.5], ['mu', 's1', 4.5], ['mu', 's2', 4.5], ['acfg', 'ac', 4.5], ['ac', 'bg', 3], ['ac', 's1', 3], ['ok', 's1', 4.5], ['danger', 's1', 4.5], ['nap', 's1', 3], ['nt', 's1', 3], ['nap', 's2', 3], ['nt', 's2', 3]];
let fail = 0;
for (const [name, t] of Object.entries(THEMES))
  for (const [a, b, min] of CHECKS) {
    const r = ratio(t[a], t[b]);
    if (r < min) { fail++; console.log(`FALLA ${name}: ${a} sobre ${b} = ${r.toFixed(2)} (mín ${min})`); }
  }
console.log(fail === 0 ? 'Contrastes OK' : `${fail} fallos`);
process.exit(fail ? 1 : 0);

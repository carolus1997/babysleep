import { expect, test } from '@playwright/test';
import { seedBaby } from './seed';

/**
 * Móviles pequeños y texto grande: en ninguna sección debe haber desbordes laterales (la página no se mueve de
 * lado) ni elementos fuera de pantalla. `html{font-size:130%}` imita «tamaño de letra grande» del sistema.
 *   npx playwright test -c tools/visual/playwright.config.ts responsive
 */
const SIZES = [
  { w: 280, h: 560 },
  { w: 320, h: 568 },
  { w: 360, h: 740 },
  { w: 412, h: 915 },
] as const;
const TABS = ['Inicio', 'Salud', 'Estadísticas', 'Ajustes'] as const;

for (const sz of SIZES)
  for (const scale of [1, 1.3])
    test(`sin desbordes ${sz.w}px, texto ${scale * 100}%`, async ({ page }) => {
      await page.setViewportSize({ width: sz.w, height: sz.h });
      await page.addInitScript((sc) => {
        localStorage.setItem('bs-tut-tour', '1');
        localStorage.setItem('bs-theme', 'light');
        document.addEventListener('DOMContentLoaded', () => {
          const st = document.createElement('style');
          st.textContent = `.splash{display:none!important}html{font-size:${sc * 100}%!important}`;
          document.head.append(st);
        });
      }, scale);
      await page.goto('/?go=seed');
      await page.evaluate(() => indexedDB.deleteDatabase('babysleep'));
      await page.reload();
      await page.evaluate(seedBaby);
      await page.reload();
      const nav = page.getByRole('navigation', { name: 'Principal' });
      await nav.waitFor();
      for (const label of TABS) {
        await nav.getByRole('button', { name: label }).click();
        await page.waitForTimeout(250);
        const bad = await page.evaluate(() => {
          const out: string[] = [];
          const W = document.documentElement.clientWidth;
          if (document.documentElement.scrollWidth > W + 1) out.push(`la página mide ${document.documentElement.scrollWidth} > ${W}`);
          for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
            if (el.closest('.tabs-fade') || el.closest('svg') || el.closest('.sr-only')) continue;
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            if (r.right > W + 1 || r.left < -1) out.push(`${el.tagName} «${(el.textContent ?? '').slice(0, 30)}» fuera (${Math.round(r.left)}–${Math.round(r.right)})`);
          }
          return out.slice(0, 8);
        });
        expect(bad, `${label}: ${bad.join(' | ')}`).toEqual([]);
      }
    });

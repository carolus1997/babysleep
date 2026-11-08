import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { seedBaby, startOpenSleep } from './seed';

const TAG = process.env.VISUAL_TAG ?? 'actual';
const OUT = `docs/design/screens/${TAG}`;
const THEMES = ['light', 'dark', 'night'] as const;
const SIZES = [{ n: '390', w: 390, h: 844 }, { n: '360', w: 360, h: 800 }] as const;
const TABS = [['home', 'Inicio'], ['stats', 'Estadísticas'], ['health', 'Salud'], ['settings', 'Ajustes']] as const;
mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/axe.txt`, '');

async function boot(page: Page, theme: string, scenario: 'empty' | 'data' | 'active') {
  await page.addInitScript((th) => {
    localStorage.setItem('bs-theme', th);
    document.addEventListener('DOMContentLoaded', () => {
      const st = document.createElement('style');
      st.textContent = '.splash{display:none!important}';
      document.head.append(st);
    });
  }, theme);
  await page.goto('/?go=today'); // `go` desconocido: salta la pantalla de perfiles
  await page.evaluate(() => indexedDB.deleteDatabase('babysleep'));
  await page.reload();
  if (scenario === 'empty') {
    await page.getByRole('textbox').first().fill('Leo');
    await page.locator('input[type=date]').fill(new Date(Date.now() - 158 * 86_400_000).toISOString().slice(0, 10));
    await page.getByRole('button', { name: 'Crear perfil' }).click();
  } else {
    await page.evaluate(seedBaby);
    if (scenario === 'active') await page.evaluate(startOpenSleep);
    await page.reload();
  }
  await page.getByRole('navigation', { name: 'Principal' }).waitFor();
}

for (const size of SIZES)
  for (const theme of THEMES)
    for (const scenario of ['empty', 'data', 'active'] as const) {
      // Solo se repite el 360 en un tema para no multiplicar capturas.
      if (size.n === '360' && (theme !== 'dark' || scenario === 'empty')) continue;
      test(`${size.n} ${theme} ${scenario}`, async ({ page }) => {
        await page.setViewportSize({ width: size.w, height: size.h });
        await boot(page, theme, scenario);
        for (const [id, label] of TABS) {
          if (scenario === 'active' && id !== 'home') continue;
          await page.getByRole('navigation', { name: 'Principal' }).getByRole('button', { name: label }).click();
          await page.evaluate(() => window.scrollTo(0, 0));
          await page.waitForTimeout(250);
          await page.screenshot({ path: `${OUT}/${size.n}-${theme}-${scenario}-${id}.png` });
          if (theme === 'light' || theme === 'night') {
            const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze();
            const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
            if (bad.length) appendFileSync(`${OUT}/axe.txt`, `${size.n} ${theme} ${scenario} ${id}: ` + bad.map((v) => `${v.id}(${v.nodes.length})`).join(', ') + '\n');
            if (process.env.VISUAL_STRICT) expect(bad, bad.map((v) => v.id).join()).toEqual([]);
          }
        }
        // Pantalla completa de Hoy (con scroll) para ver todo el contenido.
        await page.getByRole('navigation', { name: 'Principal' }).getByRole('button', { name: 'Inicio' }).click();
        await page.screenshot({ path: `${OUT}/${size.n}-${theme}-${scenario}-home-full.png`, fullPage: true });
      });
    }

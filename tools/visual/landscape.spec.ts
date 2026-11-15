import { expect, test } from '@playwright/test';
import { seedBaby } from './seed';

/**
 * Móvil tumbado (apaisado y bajo): carril lateral, sin desbordes, y el botón «Dormir» y el anillo a la vista
 * sin tener que desplazar. Diseño: docs/design/prototypes (vista «Horizontal», opción A).
 *   npx playwright test -c tools/visual/playwright.config.ts landscape
 */
for (const [w, h] of [[740, 360], [915, 412], [667, 375]] as const)
  test(`horizontal ${w}×${h}`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await page.addInitScript(() => {
      localStorage.setItem('bs-tut-tour', '1');
      localStorage.setItem('bs-theme', 'light');
      document.addEventListener('DOMContentLoaded', () => {
        const st = document.createElement('style');
        st.textContent = '.splash{display:none!important}';
        document.head.append(st);
      });
    });
    await page.goto('/?go=seed');
    await page.evaluate(() => indexedDB.deleteDatabase('babysleep'));
    await page.reload();
    await page.evaluate(seedBaby);
    await page.reload();
    const nav = page.getByRole('navigation', { name: 'Principal' });
    await nav.waitFor();

    // La barra de navegación es un carril a la izquierda, no una barra inferior.
    const box = (await nav.boundingBox())!;
    expect(box.x).toBeLessThanOrEqual(1);
    expect(box.width).toBeLessThan(100);
    expect(box.height).toBeGreaterThanOrEqual(h - 2);

    // «Dormir» entero y a la vista, aunque haya avisos abiertos.
    const pill = page.getByRole('button', { name: 'Dormir: empezar ahora' });
    const pb = (await pill.boundingBox())!;
    expect(pb.y + pb.height, 'el botón «Dormir» se sale por abajo').toBeLessThanOrEqual(h);

    for (const label of ['Inicio', 'Salud', 'Estadísticas', 'Ajustes']) {
      await nav.getByRole('button', { name: label }).click();
      await page.waitForTimeout(250);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(over, `${label}: la página se mueve de lado`).toBeLessThanOrEqual(1);
    }
  });

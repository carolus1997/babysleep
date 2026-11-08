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
    await page.getByRole('button', { name: 'Empezar de cero' }).click();
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
          if (id === 'stats') await page.screenshot({ path: `${OUT}/${size.n}-${theme}-${scenario}-stats-full.png`, fullPage: true });
          if (theme === 'light' || theme === 'night') {
            const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze();
            const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
            if (bad.length) appendFileSync(`${OUT}/axe.txt`, `${size.n} ${theme} ${scenario} ${id}: ` + bad.map((v) => `${v.id}(${v.nodes.length}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ") + " " + (n.any[0]?.message ?? "").slice(0, 120)).join(" | ")})`).join(', ') + '\n');
            if (process.env.VISUAL_STRICT) expect(bad, bad.map((v) => v.id).join()).toEqual([]);
          }
        }
        // Pantalla completa de Hoy (con scroll) para ver todo el contenido.
        await page.getByRole('navigation', { name: 'Principal' }).getByRole('button', { name: 'Inicio' }).click();
        await page.screenshot({ path: `${OUT}/${size.n}-${theme}-${scenario}-home-full.png`, fullPage: true });
      });
    }

// Acceso: bienvenida, registro del bebé y entrada con correo (sin red: el código y la vinculación necesitan servidor).
for (const theme of THEMES)
  test(`acceso ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript((th) => {
      localStorage.setItem('bs-theme', th);
      document.addEventListener('DOMContentLoaded', () => {
        const st = document.createElement('style');
        st.textContent = '.splash{display:none!important}';
        document.head.append(st);
      });
    }, theme);
    await page.goto('/?go=today');
    await page.evaluate(() => indexedDB.deleteDatabase('babysleep'));
    await page.reload();
    const shots: Array<[string, () => Promise<void>]> = [
      ['1-bienvenida', async () => {}],
      ['2-registro', async () => {
        await page.getByRole('button', { name: 'Empezar de cero' }).click();
        await page.getByRole('textbox').first().fill('Leo');
        await page.locator('input[type=date]').fill('2026-05-10');
      }],
      ['3-correo', async () => {
        await page.getByRole('button', { name: 'Volver' }).click();
        await page.getByRole('button', { name: 'Ya tengo cuenta' }).click();
        await page.getByRole('textbox').first().fill('ana@correo.com');
      }],
    ];
    for (const [name, act] of shots) {
      await act();
      await page.waitForTimeout(250);
      await page.screenshot({ path: `${OUT}/390-${theme}-acceso-${name}.png` });
      if (theme !== 'dark') {
        const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze();
        const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
        if (bad.length) appendFileSync(`${OUT}/axe.txt`, `acceso ${theme} ${name}: ` + bad.map((v) => v.id).join(', ') + '\n');
        if (process.env.VISUAL_STRICT) expect(bad, bad.map((v) => v.id).join()).toEqual([]);
      }
    }
  });

// Todas las secciones (Salud, Estadísticas, Inicio) a pantalla completa, para revisar cada una.
test('secciones', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page, process.env.VISUAL_THEME ?? 'light', 'data');
  const nav = page.getByRole('navigation', { name: 'Principal' });
  const slug = (s: string) => s.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-');
  const groups: Array<[string, string, string]> = [['Salud', 'Salud', 'Salud'], ['Estadísticas', 'Estadísticas', 'Estadísticas'], ['Inicio', 'Inicio', 'Inicio']];
  for (const [tab, , label] of groups) {
    await nav.getByRole('button', { name: tab }).click();
    const tabs = page.getByRole('group', { name: label === 'Inicio' ? 'Inicio' : label }).first();
    const names = (await tabs.getByRole('button').allTextContents()).map((s) => s.trim());
    for (const n of names) {
      await nav.getByRole('button', { name: tab }).click();
      await tabs.getByRole('button', { name: n, exact: true }).click();
      await page.waitForTimeout(250);
      await page.screenshot({ path: `${OUT}/sec-${slug(tab)}-${slug(n)}.png`, fullPage: true });
    }
  }
  await nav.getByRole('button', { name: 'Ajustes' }).click();
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}/sec-ajustes.png`, fullPage: true });
});

// Hojas inferiores con formularios: se abren una a una y se capturan (la hoja ocupa la pantalla).
test('hojas', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page, process.env.VISUAL_THEME ?? 'light', 'data');
  const nav = page.getByRole('navigation', { name: 'Principal' });
  const steps: Array<[string, string, string, string | null]> = [
    ['Salud', 'Medicación', '+ Nuevo tratamiento', 'medicacion'],
    ['Salud', 'Citas', '+ Nueva cita', 'cita'],
    ['Salud', 'Vacunas', 'Registrar vacunas', 'vacunas'],
    ['Salud', 'Crecimiento', '+ Nueva medida', 'medida'],
    ['Salud', 'Enfermedad', 'Empezar un episodio', 'enfermedad'],
    ['Salud', 'Ficha', 'Editar', 'ficha'],
    ['Inicio', 'Historial', '+ Añadir descanso', 'descanso'],
    ['Ajustes', '', '+ Añadir acontecimiento', 'acontecimiento'],
    ['Ajustes', '', '+ Añadir bebé', 'bebe'],
  ];
  for (const [tab, sub, btn, name] of steps) {
    await nav.getByRole('button', { name: tab }).click();
    if (sub) await page.getByRole('group', { name: tab }).first().getByRole('button', { name: sub, exact: true }).click();
    const b = page.getByRole('button', { name: btn }).first();
    if ((await b.count()) === 0) { appendFileSync(`${OUT}/hojas-faltan.txt`, `${btn}\n`); continue; }
    await b.click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/hoja-${name}.png` });
    await page.keyboard.press('Escape');
  }
});

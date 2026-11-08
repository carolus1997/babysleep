import { defineConfig } from '@playwright/test';

/**
 * Capturas y accesibilidad de la interfaz real (docs/design/BABYSLEEP_DESIGN_SYSTEM.md §6).
 *   npm run visual            → capturas en docs/design/screens/<VISUAL_TAG|actual>/
 *   VISUAL_TAG=antes npm run visual
 * El servidor de desarrollo se arranca solo (o se reutiliza el de 5199).
 */
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  timeout: 120_000,
  workers: 1,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:5199', timezoneId: 'Europe/Madrid', locale: 'es-ES', serviceWorkers: 'block', reducedMotion: 'reduce' },
  webServer: {
    command: 'npm run dev -w @babysleep/mobile -- --port 5199 --strictPort',
    url: 'http://127.0.0.1:5199',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});

import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@babysleep/contract': p('./packages/contract/src/index.ts'),
      '@babysleep/core': p('./packages/core/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['apps/mobile/test/setup.ts'],
    // Las pruebas temporales dependen de la base de datos IANA; se fija la zona
    // del proceso a UTC para que ningún test dependa de la zona de la máquina.
    env: { TZ: 'UTC' },
  },
});

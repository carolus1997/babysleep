import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

// En GitHub Pages la app vive en /<repositorio>/. El workflow define BASE_PATH.
const base = process.env.BASE_PATH ?? '/';

// Identifica la versión publicada: en GitHub Actions, el commit; en local, el HEAD del repositorio.
const buildId = (
  process.env.GITHUB_SHA ??
  (() => {
    try {
      return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    } catch {
      return 'dev';
    }
  })()
).slice(0, 7);

export default defineConfig({
  base,
  define: {
    __BUILD_ID__: JSON.stringify(buildId),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  resolve: {
    alias: {
      '@babysleep/contract': p('../../packages/contract/src/index.ts'),
      '@babysleep/core': p('../../packages/core/src/index.ts'),
    },
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon-192.png', 'icon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'BabySleep',
        short_name: 'BabySleep',
        description: 'Registro del sueño del bebé, privado y sin conexión',
        lang: 'es',
        start_url: base,
        scope: base,
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#f7f0e6',
        theme_color: '#f7f0e6',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        navigateFallback: `${base}index.html`,
        globPatterns: ['**/*.{js,css,html,png,svg,webmanifest,woff2}'],
        // Avisos de «toca toma» (web push): el manejador de `push` y de clic en el aviso vive en public/push-sw.js.
        importScripts: ['push-sw.js'],
      },
    }),
  ],
  server: { host: true },
});

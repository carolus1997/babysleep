import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

// En GitHub Pages la app vive en /<repositorio>/. El workflow define BASE_PATH.
const base = process.env.BASE_PATH ?? '/';

export default defineConfig({
  base,
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
      includeAssets: ['icon-192.png', 'apple-touch-icon.png'],
      manifest: {
        name: 'BabySleep',
        short_name: 'BabySleep',
        description: 'Registro del sueño del bebé, privado y sin conexión',
        lang: 'es',
        start_url: base,
        scope: base,
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#f6f7fb',
        theme_color: '#4f46e5',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: { navigateFallback: `${base}index.html`, globPatterns: ['**/*.{js,css,html,png,svg,webmanifest}'] },
    }),
  ],
  server: { host: true },
});

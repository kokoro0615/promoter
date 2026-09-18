import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Nightclub Reception',
        short_name: 'NC',
        start_url: '/',
        display: 'standalone',
        background_color: '#101014',
        theme_color: '#101014',
        icons: [],
      },
      workbox: {
        // API responses are never cached; sync goes through /api/changes.
        navigateFallbackDenylist: [/^\/api/],
        runtimeCaching: [],
      },
    }),
  ],
  server: {
    proxy: { '/api': 'http://127.0.0.1:8787' },
  },
});

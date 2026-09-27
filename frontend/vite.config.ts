import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    // Installability only — NOT an offline-first app. This app has no
    // scenario where an HR user needs live candidate/role data with no
    // internet, so there is no correct offline caching strategy for API
    // responses to design here, and caching one anyway would risk a lost/
    // shared device showing stale candidate PII (CTC, scores) offline
    // after someone's access should've been revoked. The only thing this
    // plugin caches is the built JS/CSS/HTML app shell (so the installed
    // icon opens instantly); every /api/* call is explicitly NetworkOnly —
    // it is never intercepted or served from cache, only ever proxied
    // straight through to the real network call.
    VitePWA({
      registerType: 'autoUpdate',
      // Registered manually via `virtual:pwa-register` in main.tsx instead —
      // don't also auto-inject a second registration script tag.
      injectRegister: null,
      manifest: {
        name: 'DigitalPaani Hiring Master System',
        short_name: 'HMS',
        description: 'DigitalPaani internal hiring management system',
        start_url: '/',
        display: 'standalone',
        background_color: '#F9FAFB',
        theme_color: '#002454',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Precache only the app shell (JS/CSS/HTML/icons) — Workbox's glob
        // only ever walks the built dist/ output, so /api/* is never in
        // scope here regardless; the explicit runtimeCaching rule below is
        // belt-and-suspenders documentation of that intent, not a fix for
        // an actual leak.
        globPatterns: ['**/*.{js,css,html,png,svg,ico,woff2}'],
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            urlPattern: /\/api\/.*/,
            handler: 'NetworkOnly',
          },
        ],
      },
    }),
  ],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://backend:4000', changeOrigin: true },
    },
  },
});

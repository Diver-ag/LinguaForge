import fs from 'fs';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'path';
import {defineConfig} from 'vite';

const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf-8'));
const appVersion: string = pkg.version || '0.0.0';
const buildDate: string = new Date().toISOString();

export default defineConfig(() => {
  return {
    define: {
      global: 'globalThis',
      'process.env.GEMINI_API_KEY': JSON.stringify(process.env.GEMINI_API_KEY || ''),
      __APP_VERSION__: JSON.stringify(appVersion),
      __BUILD_DATE__: JSON.stringify(buildDate),
    },
    plugins: [
      {
        name: 'serve-dict-no-gzip-encoding',
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url && req.url.includes('/dict/')) {
              const origSetHeader = res.setHeader.bind(res);
              res.setHeader = function (name: string, value: any) {
                if (name.toLowerCase() === 'content-encoding') {
                  return res;
                }
                return origSetHeader(name, value);
              };
            }
            next();
          });
        },
      },
      {
        name: 'packs-strict-404',
        configureServer(server) {
          const publicPacksRoot = path.resolve('public/packs');
          server.middlewares.use((req, res, next) => {
            const rawUrl = req.url || '';
            const pathname = rawUrl.split('?')[0];
            if (!pathname.startsWith('/packs/')) return next();

            let rel = '';
            try {
              rel = decodeURIComponent(pathname.slice('/packs/'.length));
            } catch {
              res.statusCode = 404;
              res.setHeader('Content-Type', 'text/plain; charset=utf-8');
              res.end(`File not found on server: ${pathname}`);
              return;
            }
            const resolved = path.resolve(publicPacksRoot, rel);
            const insideRoot =
              resolved === publicPacksRoot || resolved.startsWith(publicPacksRoot + path.sep);
            if (!insideRoot || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
              res.statusCode = 404;
              res.setHeader('Content-Type', 'text/plain; charset=utf-8');
              res.end(`File not found on server: ${pathname}`);
              return;
            }
            next();
          });
        },
        configurePreviewServer(server) {
          const distPacksRoot = path.resolve('dist/packs');
          server.middlewares.use((req, res, next) => {
            const rawUrl = req.url || '';
            const pathname = rawUrl.split('?')[0];
            if (!pathname.startsWith('/packs/')) return next();

            let rel = '';
            try {
              rel = decodeURIComponent(pathname.slice('/packs/'.length));
            } catch {
              res.statusCode = 404;
              res.setHeader('Content-Type', 'text/plain; charset=utf-8');
              res.end(`File not found on server: ${pathname}`);
              return;
            }
            const resolved = path.resolve(distPacksRoot, rel);
            const insideRoot =
              resolved === distPacksRoot || resolved.startsWith(distPacksRoot + path.sep);
            if (!insideRoot || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
              res.statusCode = 404;
              res.setHeader('Content-Type', 'text/plain; charset=utf-8');
              res.end(`File not found on server: ${pathname}`);
              return;
            }
            next();
          });
        },
      },
      react(),
      tailwindcss(),
      VitePWA({
        registerType: 'prompt',
        includeAssets: ['favicon.ico', 'apple-touch-icon.png', 'icon.svg'],
        manifest: {
          id: '/',
          name: 'LinguaForge',
          short_name: 'LinguaForge',
          description: 'Offline-first, local-first language learning Progressive Web App with interactive smart reader.',
          theme_color: '#4f46e5',
          background_color: '#0f172a',
          display: 'standalone',
          start_url: '/',
          scope: '/',
          icons: [
            {
              src: '/pwa-192x192.png',
              sizes: '192x192',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: '/pwa-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: '/pwa-maskable-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2,gz,dat,wasm}'],
          globIgnores: ['packs/**', '**/packs/**', '**/*.map'],
          navigateFallbackDenylist: [/^\/packs\//],
          maximumFileSizeToCacheInBytes: 20 * 1024 * 1024,
          cleanupOutdatedCaches: true,
          clientsClaim: true,
          skipWaiting: false,
          runtimeCaching: [
            {
              urlPattern: ({ url }) => url.pathname.startsWith('/packs/'),
              handler: 'NetworkOnly',
            },
            {
              urlPattern: ({ request }) => request.mode === 'navigate',
              handler: 'NetworkFirst',
              options: {
                cacheName: 'app-shell-v4',
                networkTimeoutSeconds: 2,
              },
            },
            {
              urlPattern: /\/dict\/.*\.dat\.gz$/,
              handler: 'CacheFirst',
              options: {
                cacheName: 'kuromoji-dict-v1',
                expiration: {
                  maxEntries: 20,
                  maxAgeSeconds: 60 * 60 * 24 * 365,
                },
              },
            },
          ],
        },
        devOptions: {
          enabled: false, // Network-first, avoid broken cache in dev
        },
      }),
    ],
    resolve: {
      alias: {
        '@': path.resolve('.'),
        'kuromoji': path.resolve('node_modules/kuromoji/build/kuromoji.js'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});

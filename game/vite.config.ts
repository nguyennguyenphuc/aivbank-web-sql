import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vitest/config';

export default defineConfig(() => {
  return {
    // AIV Bank phục vụ game dưới `/game/`. Build độc lập thì đặt GAME_BASE=/.
    base: process.env.GAME_BASE ?? '/game/',
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
      proxy: {
        '/game/api': {
          target: process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:3001',
          changeOrigin: true,
          rewrite: (p: string) => p.replace(/^\/game/, ''),
        },
        '/api': {
          target: process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:3001',
          changeOrigin: true,
        },
      },
    },
    preview: {
      proxy: {
        '/game/api': {
          target: process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:3001',
          changeOrigin: true,
          rewrite: (p: string) => p.replace(/^\/game/, ''),
        },
        '/api': {
          target: process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:3001',
          changeOrigin: true,
        },
      },
    },
    test: {
      include: ['tests/**/*.test.ts'],
      exclude: ['**/node_modules/**', '**/dist/**', '.agents/**', '.codex/**'],
    },
  };
});

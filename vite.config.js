import { defineConfig } from 'vite';

// The WebCodecs export path needs no SharedArrayBuffer, so cross-origin isolation is
// optional. We ship the headers anyway because every asset here is same-origin — that
// keeps the door open for @ffmpeg/core-mt without breaking anything today.
const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin'
};

export default defineConfig({
  base: './',
  server: { headers: crossOriginIsolation, port: 5173 },
  preview: { headers: crossOriginIsolation },
  worker: { format: 'es' },
  build: { target: 'esnext', sourcemap: true },
  optimizeDeps: { exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'] }
});

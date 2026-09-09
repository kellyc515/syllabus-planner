import { defineConfig } from 'vite';

// Static single-page app. Base is relative so a `vite build` can be hosted
// from any subpath (GitHub Pages, Netlify, a plain folder, etc.).
export default defineConfig({
  base: './',
  server: { open: true },
  build: { outDir: 'dist', target: 'es2020' },
});

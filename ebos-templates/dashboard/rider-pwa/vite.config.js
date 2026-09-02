import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Served at /rider/... on the same server as the staff dashboard (see
  // ../server.js) -- every asset URL vite emits needs this prefix, or the
  // browser requests them from / and gets the staff dashboard's own
  // index.html back instead (its own SPA fallback swallows anything it
  // doesn't recognise).
  base: '/rider/',
  plugins: [react()],
  server: {
    // Local dev only -- proxies /rider/api to the real backend (npm run
    // dev in server.js's folder) so the two can run separately, same
    // pattern as client/vite.config.js's own /api proxy.
    proxy: {
      '/rider/api': 'http://localhost:3000',
    },
  },
  build: {
    outDir: 'dist',
  },
});

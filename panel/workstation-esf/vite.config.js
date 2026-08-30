import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/workstation-esf/',
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:4100',
    },
  },
  build: {
    outDir: 'dist',
  },
});

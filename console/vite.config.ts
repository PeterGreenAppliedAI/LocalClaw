import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/console/',
  server: {
    proxy: {
      '/console/api': 'http://localhost:3100',
      '/api/voice': 'http://localhost:3100',
    },
  },
  build: {
    outDir: 'dist',
  },
});

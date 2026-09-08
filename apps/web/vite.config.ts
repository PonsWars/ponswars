import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // Staged loading (§82.3) starts with an honest budget. A single bundle that
    // grows past this without anyone noticing is how a first paint ends up
    // behind a megabyte of world runtime.
    chunkSizeWarningLimit: 900,
  },
});

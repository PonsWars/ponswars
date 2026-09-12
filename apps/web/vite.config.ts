import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Matches a module inside any of the named packages, whichever separator the
 * platform's paths use.
 */
function inPackages(...names: readonly string[]): RegExp {
  return new RegExp(`[\\\\/]node_modules[\\\\/](${names.join('|')})[\\\\/]`);
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // Staged loading (§82.3) starts with an honest budget. A single bundle that
    // grows past this without anyone noticing is how a first paint ends up
    // behind a megabyte of world runtime.
    chunkSizeWarningLimit: 900,
    rolldownOptions: {
      output: {
        codeSplitting: {
          // Split along how often each part changes. three.js and the React
          // bindings for it move when a dependency is upgraded; the world's own
          // code moves with every deploy. As one megabyte, every deploy
          // invalidated all of it — a returning player re-downloaded the renderer
          // to get a new tooltip.
          //
          // By package, never by size, and in priority order. A group takes its
          // captured modules' dependencies with it, so React is claimed first by
          // a group of its own: left to the React-three group it went along with
          // the bindings, the shell then needed that chunk to paint, and three.js
          // came with it — the whole world back in the first paint (§82.3).
          groups: [
            {
              name: 'react',
              test: inPackages(
                'react',
                'react-dom',
                'scheduler',
                'zustand',
                'use-sync-external-store',
              ),
              priority: 3,
            },
            { name: 'three', test: inPackages('three'), priority: 2 },
            {
              name: 'react-three',
              test: inPackages(
                '@react-three',
                'three-stdlib',
                '@monogrid',
                'troika-three-text',
                'troika-three-utils',
                'troika-worker-utils',
                'camera-controls',
                'maath',
                'meshline',
                'stats-gl',
                'suspend-react',
                'its-fine',
                'react-reconciler',
                'react-use-measure',
              ),
              priority: 1,
            },
          ],
        },
      },
    },
  },
});

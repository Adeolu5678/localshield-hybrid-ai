import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const rootDir = resolve(__dirname);
const extensionDir = resolve(rootDir, 'extension');
const outDir = resolve(rootDir, 'dist-extension');

function copyExtensionStaticAssets(): Plugin {
  return {
    name: 'copy-extension-static-assets',
    closeBundle() {
      mkdirSync(outDir, { recursive: true });
      cpSync(
        resolve(extensionDir, 'manifest.json'),
        resolve(outDir, 'manifest.json')
      );
      const iconsSrc = resolve(extensionDir, 'icons');
      if (existsSync(iconsSrc)) {
        cpSync(iconsSrc, resolve(outDir, 'icons'), { recursive: true });
      }
    }
  };
}

export default defineConfig({
  root: extensionDir,
  envDir: rootDir,
  publicDir: false,
  base: './',
  plugins: [react(), copyExtensionStaticAssets()],
  build: {
    outDir,
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    rollupOptions: {
      input: {
        sidepanel: resolve(extensionDir, 'sidepanel.html'),
        background: resolve(extensionDir, 'background.ts')
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === 'background'
            ? 'background.js'
            : 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]'
      }
    }
  }
});

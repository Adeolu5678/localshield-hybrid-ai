import fs from 'node:fs';
import path from 'node:path';
import { buildSync } from 'esbuild';

let key = '';
const envPath = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  const envText = fs.readFileSync(envPath, 'utf8');
  const geminiMatch = envText.match(/^VITE_GEMINI_API_KEY=(.+)$/m);
  const firebaseMatch = envText.match(/^VITE_FIREBASE_API_KEY=(.+)$/m);
  const raw = geminiMatch?.[1] ?? firebaseMatch?.[1] ?? '';
  key = raw.trim().replace(/^['"]|['"]$/g, '');
}

buildSync({
  entryPoints: ['extension/content.ts'],
  bundle: true,
  format: 'iife',
  outfile: 'dist-extension/content.js',
  minify: true,
  define: {
    'process.env.VITE_FIREBASE_API_KEY': JSON.stringify(key)
  }
});

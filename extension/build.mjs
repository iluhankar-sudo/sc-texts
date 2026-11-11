import { build, context } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });
cpSync('public', 'dist', { recursive: true });

const options = {
  entryPoints: {
    background: 'src/background.ts',
    offscreen: 'src/offscreen.ts',
    content: 'src/content/index.tsx',
    options: 'src/options.ts',
    popup: 'src/popup.ts',
  },
  outdir: 'dist',
  bundle: true,
  format: 'iife',
  target: 'chrome116',
  jsx: 'automatic',
  sourcemap: true,
  define: {
    'process.env.NODE_ENV': '"production"',
    __DEFAULT_API_KEY__: JSON.stringify(process.env.DEFAULT_API_KEY ?? ''),
  },
  logLevel: 'info',
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('watching… (public/ копируется только при старте)');
} else {
  await build(options);
}

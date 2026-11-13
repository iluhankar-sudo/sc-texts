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
    // Proxy for users without their own key (embedded in builds for others).
    __PROXY_URL__: JSON.stringify(process.env.PROXY_URL ?? ''),
    __APP_TOKEN__: JSON.stringify(process.env.APP_TOKEN ?? ''),
  },
  logLevel: 'info',
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('watching... (public/ is copied only at start)');
} else {
  await build(options);
}

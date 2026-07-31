import { defineConfig } from 'tsup';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

function copy(src: string, dest: string): void {
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
}

export default defineConfig({
  entry: {
    'core/index': 'src/core/index.ts',
    'server/index': 'src/server/index.ts',
    'server/nextjs': 'src/server/nextjs.ts',
    'react/index': 'src/react/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  splitting: false,
  clean: true,
  sourcemap: true,
  external: [
    'react',
    'react-dom',
    'mongoose',
    'pusher',
    'pusher-js',
    '@anthropic-ai/sdk',
    'zod',
  ],
  loader: {
    '.json': 'json',
  },
  async onSuccess() {
    copy('src/react/widget/widget.css', 'dist/react/widget.css');
    copy('src/react/admin/admin.css', 'dist/react/admin.css');
    copy('src/i18n/en.json', 'dist/i18n/en.json');
    copy('src/i18n/bn.json', 'dist/i18n/bn.json');
    // eslint-disable-next-line no-console
    console.log('✓ copied CSS + i18n assets');
  },
});

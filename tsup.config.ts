import { defineConfig } from 'tsup';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

function copy(src: string, dest: string): void {
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
}

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'widget/index': 'src/widget/index.ts',
    'server/index': 'src/server/index.ts',
    'admin/index': 'src/admin/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  splitting: false,
  clean: true,
  sourcemap: true,
  // Everything here is an optional peer dependency: the widget entry must not
  // drag Mongoose into a browser bundle, and the server entry must not pull in
  // React. Bundling any of them would also risk duplicate copies in the host app.
  external: ['react', 'react-dom', 'mongoose', '@anthropic-ai/sdk', 'ws', 'zod'],
  loader: {
    '.json': 'json',
  },
  async onSuccess() {
    copy('src/widget/widget.css', 'dist/widget/widget.css');
    copy('src/admin/admin.css', 'dist/admin/admin.css');
    // eslint-disable-next-line no-console
    console.log('✓ copied widget + admin stylesheets');
  },
});

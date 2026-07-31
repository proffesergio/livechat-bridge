#!/usr/bin/env node
/**
 * Build + link this package into a sibling Next.js project ("atharnur") so
 * iteration is fast. Tries pnpm first, then npm.
 *
 * Usage:
 *   pnpm dev:link-atharnur
 *   pnpm dev:link-atharnur ../my-other-app
 */
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const target = resolve(process.argv[2] ?? '../atharnur');

if (!existsSync(target)) {
  console.error(`Target app not found at ${target}.`);
  console.error('Pass a path: pnpm dev:link-atharnur ../my-app');
  process.exit(1);
}

const run = (cmd, cwd) => {
  console.log(`\n$ (${cwd}) ${cmd}`);
  execSync(cmd, { stdio: 'inherit', cwd });
};

const here = process.cwd();
run('pnpm build', here);

const pm = existsSync(resolve(target, 'pnpm-lock.yaml')) ? 'pnpm' : 'npm';

if (pm === 'pnpm') {
  run(`pnpm link --global`, here);
  run(`pnpm link --global livechat-bridge`, target);
} else {
  run('npm link', here);
  run('npm link livechat-bridge', target);
}

console.log('\n✓ Linked. Restart the target dev server so it picks up the new build.');

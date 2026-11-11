import { resolve } from 'node:path';
import { cp, mkdir, rm } from 'node:fs/promises';
import { build } from 'vite';

const site = resolve('.cache/browser-smoke/site');
await rm(site, { recursive: true, force: true });
await mkdir(site, { recursive: true });
await cp(resolve('dist'), site, { recursive: true });

// A separate component page: production modules and styles, no full-app hooks.
await build({
  configFile: false,
  root: resolve('tests/browser/fixture'),
  base: '/browser-fixture/',
  build: { outDir: resolve(site, 'browser-fixture'), emptyOutDir: true },
});

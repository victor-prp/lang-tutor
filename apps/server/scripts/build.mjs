// Phase 30 (spec D2). Bundles the server's two entry points for the image:
// dist/index.js, the server, and dist/cli.js, which migrates and seeds. Our own
// workspace code is inlined, which is the point: @lang-tutor/core ships
// TypeScript source and the image carries no TypeScript tooling. Every
// third-party dependency stays external and is installed by npm in the image,
// so packages load exactly as they do under tsx.
import { build } from 'esbuild';
import { cpSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
// esbuild treats a listed package's subpaths (hono/cors, drizzle-orm/...) as
// external too.
const external = Object.keys(pkg.dependencies).filter((name) => !name.startsWith('@lang-tutor/'));
const dist = join(root, 'dist');

rmSync(dist, { recursive: true, force: true });
await build({
  absWorkingDir: root,
  entryPoints: { index: 'src/index.ts', cli: 'src/db/cli.ts' },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  external,
  sourcemap: true,
  logLevel: 'info',
});

// migrate.ts finds the folder beside the running file (__dirname), which in the
// bundle is dist/.
cpSync(join(root, 'src/db/migrations'), join(dist, 'migrations'), { recursive: true });

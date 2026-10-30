// Builds the publishable package: dist/server and dist/mcp as plain .js.
// The repo runs .ts directly via Node's type stripping, but Node refuses to
// strip types for files under node_modules, so an installed package needs
// real .js. The same built-in stripper does the work (no compiler or bundler
// dependency); the only other change is rewriting relative ".ts" import
// specifiers to ".js".
import { stripTypeScriptTypes } from 'node:module';
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const out = join(root, 'dist');
rmSync(out, { recursive: true, force: true });

// Relative specifiers only ('./x.ts', '../server/x.ts'), quoted either way.
export const rewriteSpecifiers = (code: string): string =>
  code.replace(/(['"])(\.\.?\/[^'"\n]+)\.ts\1/g, '$1$2.js$1');

for (const dir of ['server', 'mcp']) {
  mkdirSync(join(out, dir), { recursive: true });
  for (const f of readdirSync(join(root, dir))) {
    if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue;
    const js = rewriteSpecifiers(stripTypeScriptTypes(readFileSync(join(root, dir, f), 'utf8'), { mode: 'strip' }));
    const dest = join(out, dir, f.replace(/\.ts$/, '.js'));
    writeFileSync(dest, js);
    if (js.startsWith('#!')) chmodSync(dest, 0o755);
  }
}
console.log(`built ${out}`);

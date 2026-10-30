// Where devhud's files live. Running from a git checkout (the dev setup)
// keeps everything in the repo as it always has: config.json at the root,
// state in data/. An installed package (npm i -g devhud / npx) can't write
// next to its own code, so config and state go to ~/.devhud instead.
// DEVHUD_HOME overrides both.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
// server/ in a checkout, dist/server/ in a built package: the package root is
// whichever ancestor holds package.json.
export const PACKAGE_ROOT = existsSync(resolve(here, '..', 'package.json')) ? resolve(here, '..') : resolve(here, '..', '..');
// By source presence, not .git: a ZIP download or an rsync without .git is
// still a source tree. server/paths.ts is never in the package's files list.
export const IS_CHECKOUT = existsSync(join(PACKAGE_ROOT, 'server', 'paths.ts'));
export const HOME = process.env.DEVHUD_HOME ? resolve(process.env.DEVHUD_HOME) : IS_CHECKOUT ? PACKAGE_ROOT : join(homedir(), '.devhud');
export const CONFIG_PATH = join(HOME, 'config.json');
export const STATE_PATH = join(HOME, 'data', 'state.json');
export const WEB_DIST = join(PACKAGE_ROOT, 'web', 'dist');

import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // .claude/worktrees holds other sessions' checkouts of this repo; without
    // this every test file ran up to three times and the stale copies failed.
    exclude: [...configDefaults.exclude, '.claude/**', 'dist/**'],
    setupFiles: ['./vitest.setup.ts'],
  },
});

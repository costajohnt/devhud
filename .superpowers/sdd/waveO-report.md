# Wave O — audit PR 2: local footprint, honesty, docs

## Status: done

## Commit
35ecd26 — fix: local footprint, npm ci, port validation, architecture docs

## What changed

**M2 — `.gitignore` gap (`data/*.json` missed `data/state.json.bak`)**: changed to `data/*` plus `!data/.gitkeep`. Verified by touching `data/state.json`, `data/state.json.bak`, and `data/server.pid` in the worktree — `git status --short` stayed clean for all three, and `data/.gitkeep` is still tracked (`git ls-files data/`).

**M3 — launchd log path**: `StandardOutPath`/`StandardErrorPath` moved from `/tmp/simon-dash.log` to `REPLACE_WITH_HOME/Library/Logs/simon-dash.log`, matching the plist's existing `REPLACE_WITH_REPO_PATH` placeholder convention (launchd doesn't expand `~`). README's launchd section updated: the edit instructions now mention both placeholders, and the "Logs go to" line explains why (`/tmp` is world-readable and shared across users; the server logs every request path and Jira issue key).

**LOW — `npm ci` for install steps**: README Setup section's three install commands (root, web, mcp) changed from `npm i` to `npm ci`, with a one-sentence explanation that this same install doubles as the deployment path on a machine that may hold write-enabled credentials. Left two things alone per your scoping: the Claude-integration section's standalone `cd mcp && npm i` (that section is PR1's territory this wave, and it's the same instruction repeated for someone who skips straight there — not a distinct dev-path), and the CLI section's `npm run cli` example (unrelated, not an install step).

**LOW — `server/config.ts` port validation**: `loadConfig` now throws the same readable-error shape as its other field validations when `port` isn't an integer in range. One judgment call worth flagging: I initially implemented 1-65535 per your literal spec, but that broke 3 existing tests (`server.test.ts`'s write-back tests use `port: 0` in on-disk config fixtures, and `port: 0` is Node's own standard convention for "bind to any free port," used by `server.listen(0, ...)` throughout this codebase's own test servers, not a mistake to reject). Changed the valid range to 0-65535 so 0 stays valid; commented why in the code. 3 new tests cover both directions: valid at both ends (0 and 65535, plus 1), and each invalid case (too big, negative, fractional, non-numeric string).

**LOW docs — `docs/ARCHITECTURE.md` module map**: added the four missing server bullets (actions.ts, transport.ts, writeback.ts, cli.ts) in the existing format, and a new "### MCP (`mcp/`)" section covering handlers.ts and index.ts plus the 8-tool list, with a one-line pointer back to the existing Concurrency section rather than duplicating it (Concurrency's own text already correctly says "CLI/MCP" throughout — left it untouched per your instruction). Fixed the three stale `.js` references (`demo.js` in the data-flow diagram, `index.js` x2 in Concurrency and Design-decisions) that survived the ts-convert wave's doc sweep.

**Unplanned but included**: `npm ci`/`npm i` regenerated `package-lock.json` and `mcp/package-lock.json` — both still had a stale `server/cli.js` bin path left over from before the TypeScript conversion (package.json says `cli.ts`, lockfile said `cli.js`). This is a 2-line diff in each lockfile, a genuine drift-correction, not scope creep I introduced; flagging it explicitly since it wasn't in your numbered list.

## Verification

- `npx tsc --noEmit`: **clean.**
- `npx vitest run`: **170/170 passed** (167 baseline + 3 new port-validation tests), 13 files.
- `plutil -lint launchd/com.johncosta.simon-dash.plist`: **OK.**
- `git status --short`: clean before and after the commit.
- Did not touch `.claude/worktrees/audit-pr1` or its branch.

## Concerns

- The port-range judgment call above (0-65535 instead of the literally-specified 1-65535) — flagging explicitly in case you want it reverted to strictly 1-65535 with the `port: 0` test fixtures changed instead. I chose to keep 0 valid because it's real, documented Node behavior this codebase already depends on in its own tests, not an oversight to close.
- None of my changes touch README's Claude-integration section or Setup's chmod line, per your note about PR1's territory — worth a quick diff-review at merge time to confirm no accidental adjacency conflicts, but I did not see any overlapping lines when I made my edits.

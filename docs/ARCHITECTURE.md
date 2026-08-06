# Architecture

## Module map

### Server (`server/`, TypeScript, erasable-syntax only, no build step — Node's native type stripping runs `.ts` files directly)

- **index.ts**: HTTP server (`node:http`). Routes `/api/data`, `/api/events` (SSE), `/api/refresh`, `/api/action`, `/api/write`, and falls back to static file serving + SPA fallback for everything else. Owns the single in-memory `state` object, the scheduled refresh loop, the SSE broadcast set, and the single-instance guard.
- **config.ts**: Loads and validates `config.json`. Fills defaults (port 3010, default Jira statuses), reads `GITHUB_TOKEN` env var as a token fallback.
- **state.ts**: `data/state.json` load/save, migrations (`celebrated` string→object, `prLog` backfill), and `cardState` (per-card override/seen-horizon lookup, created lazily).
- **jira.ts**: Jira Cloud REST client: JQL search, ADF-to-plain-text flattening, comment pagination fallback for cards with more comments than the search endpoint embeds.
- **github.ts**: GitHub REST client: PR list per repo, PR detail enrichment (comments, reviews, check runs), CI/review-state derivation.
- **link.ts**: Matches PRs to Jira cards by branch name, PR title, PR body (`/browse/KEY` link), or card description (containing the PR URL); returns the unlinked leftovers.
- **classify.ts**: Given a card + its linked PR + its stored `cardState`, decides the bucket and attention flags.
- **refresh.ts**: Orchestrates one refresh cycle: fetch (or demo-generate), link, classify, build the full snapshot payload (`buildSnapshot`), including `prLog` upsert and the `recentActivity`/`closedPrs` derivations. Also the fallback-to-last-known-good logic on partial fetch failure.
- **demo.ts**: Canned cards/PRs shaped to match `jira.ts`/`github.ts` output, so demo mode runs the real `buildSnapshot` pipeline with no network.
- **actions.ts**: `applyAction()` — shared ack/move logic used by the HTTP handler (`POST /api/action`) and the CLI's `ack`/`move` commands, so the two transports can't drift on semantics. Also exports `BUCKETS`, the list of buckets a manual move can target (excludes `needs_attention`).
- **transport.ts**: Dual-transport primitives shared by the CLI and MCP server: `probeServer()` (is a real server answering on the configured port), `serverAppearsRunning()`/`saveStateGuarded()` (the split-brain guard for direct-mode writes — see Concurrency below).
- **writeback.ts**: `performWrite()` — the single entry point for every write-back path (`POST /api/write`, the CLI's `transition`/`comment`/`pr-comment` commands, the MCP write tools). Builds the minimal ADF doc for Jira comments, re-reads `config.json` fresh on every call so `writeEnabled` takes effect without a restart, and refreshes the board after a successful write.
- **cli.ts**: `simon-dash` CLI (`status`/`refresh`/`ack`/`move`/`transition`/`comment`/`pr-comment`/`serve`/`open`). Same dual-transport rule as everything else: proxies through a running server's HTTP API when one's up, otherwise operates directly on `data/state.json` via the modules above.
- **types.ts**: Shared types (Card, Pr, Item, Snapshot, State, Config, ActionResult, WriteResult) mirroring `web/src/types.ts`'s payload shapes.

### MCP (`mcp/`, TypeScript, erasable-syntax only, no build step)

A stdio MCP server exposing the board to Claude sessions, using the exact same dual-transport rule as the CLI (see `transport.ts` above and the Concurrency section below — MCP direct-mode writes go through the same split-brain guard).

- **handlers.ts**: Tool handler functions (`boardStatus`, `doRefresh`, `ackCard`, `moveCard`, `cardComments`, `transitionCard`, `commentCard`, `commentPr`), kept separate from the stdio wiring so they're callable directly in tests without a real MCP transport. Each probes for a running server first, proxies through its HTTP API if one's up, and falls back to direct disk access (via `server/state.ts`/`refresh.ts`/`actions.ts`/`writeback.ts`) otherwise.
- **index.ts**: Registers the 8 tools above on an `McpServer` and connects a `StdioServerTransport`. Read tools (`board_status`, `refresh`, `ack_card`, `move_card`, `card_comments`) are always available; the three write tools (`transition_card`, `comment_card`, `comment_pr`) are real mutations gated by `writeEnabled` and always a no-op in demo mode, and their tool descriptions explicitly instruct the calling model to draft content and get the user's approval before calling them.

### Web (`web/src/`, Preact + TypeScript, Vite build)

- **main.tsx**: Entry point: mounts `<App>` wrapped in an `<ErrorBoundary>`.
- **app.tsx**: Top-level shell: live-update/refresh wiring, theme state (OS-aware), route branching (`/`, `/merged`, `/closed`, 404), header, banners, toast.
- **use-data.ts**: `useData()` hook: holds an `EventSource` on `/api/events` for all data (initial render included), exposes `refresh()` for the manual button and `act()` for `/api/action` calls with error handling.
- **board.tsx**: `useBoardFilter()` hook (search/status/repo filter state, drag-and-drop handlers) plus `BoardStats`, `BoardFilterBar`, `BoardList` components.
- **detail.tsx**: Card detail side panel: PR/CI/review status, new comments, full comment history, ack/move actions.
- **extras.tsx**: TODO section, Unlinked PRs section, Recent Activity (grouped by merged/closed/comment).
- **merged.tsx**: `/merged` full-page sortable table of `mergedCards`.
- **closed.tsx**: `/closed` full-page sortable table of `closedPrs`.
- **chart-panel.tsx**: Chart.js-backed Monthly Activity (line) and Top Repos (stacked bar) charts, built from `prLog`.
- **chart-panel-lazy.tsx**: Dynamic-import wrapper around `chart-panel.tsx` so Chart.js ships in its own chunk, not the initial bundle.
- **celebrate.ts**: Lazy-loaded `canvas-confetti` wrapper, respects `prefers-reduced-motion`.
- **count-up.tsx**: `AnimatedValue`: eased count-up animation for stat card numbers.
- **error-boundary.tsx**: Top-level render-error catch, so a bad payload shape doesn't blank the whole page.
- **skeleton-loader.tsx**: Loading-state placeholder cards.
- **types.ts**: Shared TypeScript types mirroring the server payload shape (see API.md for the authoritative field list).

## Data flow

```
config.json ──► loadConfig()
                    │
POST /api/refresh   ▼
     │        fetchJiraCards() / fetchPrs()+enrichPr()   (or demo.ts in demo mode)
     │                    │
     │                    ▼
     │            linkPrsToCards()  : match PRs to cards
     │                    │
     │                    ▼
     │            classifyCard()    : bucket + attention, per card
     │                    │
     │                    ▼
     │            buildSnapshot()   : assembles the full payload:
     │                                buckets, todo, unlinkedPrs, closedPrs,
     │                                mergedCards, recentActivity, prLog
     │                    │
     │                    ▼
     │            state.snapshot = payload;  saveState(data/state.json)
     ▼
  response ──► GET /api/data returns state.snapshot directly (no recompute)
```

`POST /api/action` (ack/move) mutates `state.snapshot` in place (splicing the item between bucket arrays, clearing attention) and persists, without going through `buildSnapshot` again. It's a local edit of the last snapshot, not a new fetch.

Freshness is server-owned: `index.ts` runs its own refresh loop (`refreshIntervalSeconds`, default 120s) and broadcasts every new snapshot over `GET /api/events` (Server-Sent Events) — after scheduled refreshes, manual `/api/refresh` calls, actions, and writes. On the client, `useData()` holds one `EventSource` open and renders whatever arrives; the initial render comes from the connect event (the server sends the current snapshot immediately), so there is no mount-time `/api/data` fetch and no client-side poll timer. The manual Refresh button still calls `/api/refresh` directly.

## state.json anatomy

```
{
  cards: { [jiraKey]: { lastSeenPr, lastSeenJira, override, overrideAt } },
  celebrated: [{ id: "org/repo#num", at: isoString | null }],
  mergedTotal: number,
  lastRefreshAt: isoString | null,
  snapshot: <last full payload, or null>,
  lastCards: <last successful Jira fetch, or null>,
  lastPrs: <last successful GitHub fetch, or null>,
  prLog: { [id]: { id, repo, openedAt, mergedAt, closedAt } }
}
```

- **cards**: per-card local overrides. `override`/`overrideAt` record a manual bucket pin; `lastSeenPr`/`lastSeenJira` are the comment "seen" horizons used by `classifyCard` to decide what counts as new.
- **celebrated**: every PR ever observed merged, so `mergedTotal` only increments once per PR and confetti only fires once per merge, even across process restarts and even after the card ages out of Jira's fetch window.
- **lastCards** / **lastPrs**: last-known-good fetch results, used to backfill the board on a partial or total source failure instead of blanking it.
- **prLog**: full PR lifecycle history (see API.md), a superset of what `celebrated` tracks; never pruned.
- **snapshot**: the exact payload the API returns; recomputed by `buildSnapshot` on every refresh, read as-is by `GET /api/data`.

### `.bak` rotation strategy

`saveState` only rotates the current `state.json` to `state.json.bak` if the current file parses as valid JSON. This protects against overwriting a good `.bak` with a corrupt one: if the current file is already corrupt (e.g. from a crash mid-write on a prior run), rotating it would destroy the one fallback `loadState` has. `loadState` itself: on a missing file, returns a fresh empty state (normal first run, no warning). On an unparseable file, it warns and falls back to `.bak`; if `.bak` is also unparseable, falls back to empty state.

Writes go through a temp file (`state.json.tmp`) and `renameSync`, so a crash mid-write never leaves a half-written `state.json` in place; the rename is atomic on the same filesystem.

## Classification rules

| Bucket | Condition |
|---|---|
| `needs_attention` | Any attention trigger fires (see below), regardless of any override. |
| `in_qa` | No attention trigger, and either the card has a manual override to `in_qa`, or (no override) the Jira status equals the configured "In Test" status. |
| `waiting_review` | No attention trigger, no override pointing elsewhere, PR is open with a non-`none` review state. |
| `in_progress` | Default: none of the above apply. |

Attention triggers (any one of these puts the card in `needs_attention`, appended to `item.attention`):

| Trigger | Condition |
|---|---|
| `ci_failing` | Linked PR is open and its CI status is `failing`. |
| `new_pr_comments` | One or more GitHub PR comments from someone other than the configured username, newer than `cardState.lastSeenPr`. |
| `new_jira_comments` | One or more Jira comments from someone other than the card's own author, newer than `cardState.lastSeenJira`. |
| `merged_not_in_test` | Linked PR is merged but the Jira card's status is neither "In Test" nor "Done" yet. |

A manual override (`type: 'move'`) is honored only when no attention trigger fires. The "live" triggers (CI failing, merged-not-in-test) always re-flag the card into `needs_attention` on the next refresh even if it was previously pinned elsewhere. Only the comment-based triggers are silenced by acking or moving, because those actions reset the seen horizon; CI status and merge state aren't horizon-gated, they're re-evaluated fresh every refresh.

Before any bucket classification: cards with Jira status "To Do" are split into `todo` and skip classification. Cards with a merged, linked PR are added to `celebrated`/`mergedTotal` once; if the card's Jira status is also "Done", it moves to `mergedCards` and leaves the board entirely (skipping the bucket loop). Cards with Jira status "Done" but no merged PR (or already handled above) are dropped from the board without classification.

## Concurrency

`state.json` has three kinds of writer, with three different levels of protection:

- **A single running server.** Fully safe. `index.ts` loads `state.json` once into an in-memory closure and every request handler mutates that one object synchronously (no `await` between mutate and `saveState`), so two concurrent HTTP requests can't interleave a partial write — see the first bullet under "Design decisions worth knowing" below.
- **The server plus a direct-mode CLI/MCP call.** Guarded, not eliminated. Direct mode (CLI/MCP with no server answering the probe) checks `serverAppearsRunning()` — is `data/server.pid` present and does that pid respond to `process.kill(pid, 0)` — both early (before doing any real work: a Jira/GitHub write, a full refresh) and again immediately before the actual `saveState()` call (`saveStateGuarded()` in `server/transport.ts`), closing the window where a server starts mid-operation. This stops the server and a direct-mode process from silently clobbering each other's save. It is **not** perfect: a pid can be reused by an unrelated process after the original server died (an accepted, deliberately-not-solved residual risk — see the comment on `serverAppearsRunning`).
- **Two direct-mode processes running at the same time, no server at all.** **Unguarded.** Two `simon-dash ack PROJ-1` invocations launched back to back from two terminals (or two MCP tool calls landing concurrently with no server up) each `loadState()` their own in-memory copy, mutate it, and `saveState()` — last writer wins, silently. `serverAppearsRunning()` only detects an actual server (identified by `data/server.pid`); a sibling direct-mode process writes no pid file and is invisible to it. This is a known gap, not an oversight: closing it would need a lock file or similar cross-process coordination that direct mode's whole design (no daemon, no lock server, just read-mutate-write against a JSON file) doesn't have. In practice this matters only if you're scripting concurrent direct-mode calls; the common case (interactive CLI use, or a server running) doesn't hit it.

## Design decisions worth knowing

- **In-memory shared state, write-through to disk.** `index.ts` loads `state.json` once at server startup and holds it in a closure for the life of the process; every request handler mutates that same object and persists it. Reading from disk per-request would be safe but wasteful; the actual reason for the once-only load is to avoid a lost-update race between concurrent `/api/refresh` and `/api/action` calls. Since every handler's mutate+save section runs synchronously with no `await` in between, interleaving can only happen at an `await` boundary, at which point no partially-mutated state is ever visible to a different handler.
- **Loopback bind (`127.0.0.1`), not `0.0.0.0`.** There's no authentication on the API, so binding to all interfaces would expose card data and mutation endpoints to anything on the local network. This is a single-user local tool by design.
- **Lazy-loaded chart chunk.** Chart.js is tens of KB gzipped. `chart-panel-lazy.tsx` defers importing the real `chart-panel.tsx` until it actually mounts (gated on `prLog.length > 0`), so a fresh install or a demo-mode-off/no-data state doesn't pay that download cost before first paint. A skeleton renders in the same slot while the chunk fetches, so there's no layout shift.
- **`preact-iso`'s `useLocation()` instead of `<Router>`/`<Route>`.** `<Router>`/`<Route>` memoize the rendered route on `[url, JSON.stringify(matchProps)]` and freeze the *first* render's closure. An inline `component={() => (...)}` referencing outer state (`data`, `board`, `selected`) would never see later updates after that first freeze. Clicks, search, and refresh would silently stop working after mount. Reading `path` from `useLocation()` and branching in plain JS inside one component sidesteps that memoization entirely, at the cost of manually handling the "no route matched" case.
- **Charts created once, updated in place, not destroyed and recreated on every data change.** Every `/api/data`/`/api/refresh`/`/api/action` response produces fresh array/object identities for `prLog`. A naive `useEffect` that destroys and recreates the Chart.js instance on every identity change would replay the ~1.5s entrance animation on every refresh and every drag-and-drop action. Both charts instead hold a `useRef<Chart>` and call `chart.update('none')` on subsequent effect runs, only calling `new Chart(...)` once; the ref is destroyed only on component unmount.

# Architecture

## Module map

### Server (`server/`, TypeScript, erasable-syntax only, no build step — Node's native type stripping runs `.ts` files directly)

- **index.ts**: HTTP server (`node:http`). Routes `/api/data`, `/api/events` (SSE), `/api/refresh`, `/api/action`, `/api/write`, and falls back to static file serving + SPA fallback for everything else. Owns the single in-memory `state` object, the scheduled refresh loop, the SSE broadcast set, and the single-instance guard.
- **config.ts**: Loads and validates `config.json`. Fills defaults (port 3010, default Jira statuses), reads `GITHUB_TOKEN` env var as a token fallback.
- **state.ts**: `data/state.json` load/save, migrations (`celebrated` string→object, `prLog` backfill), and `cardState` (per-card override/seen-horizon lookup, created lazily).
- **jira.ts**: Jira Cloud REST client: JQL search, ADF-to-plain-text flattening, comment pagination fallback for cards with more comments than the search endpoint embeds.
- **github.ts**: GitHub REST client: PR list per repo, PR detail enrichment (comments, reviews, check runs), CI/review-state derivation. Requests go through one `gh()` helper that carries the conditional-request (ETag) cache and the secondary-rate-limit backoff: a 403/429 that names the secondary limit or carries `Retry-After`/an exhausted `x-ratelimit-remaining` is retried up to 3 times (Retry-After, else the reset timestamp, else exponential backoff from 1s, capped at 60s) before it throws (#69). Refresh paces its enrich batches for the same reason — the limit is rate-shaped, so concurrency caps alone don't hold it.
- **link.ts**: Matches PRs to Jira cards by branch name, PR title, PR body (`/browse/KEY` link), or card description (containing the PR URL); returns the unlinked leftovers.
- **classify.ts**: Given a card + its linked PR + its stored `cardState`, decides the bucket and attention flags.
- **refresh.ts**: Orchestrates one refresh cycle: fetch (or demo-generate), link, classify, build the full snapshot payload (`buildSnapshot`), including `prLog` upsert and the `recentActivity`/`doneCards` derivations. Also the fallback-to-last-known-good logic on partial fetch failure.
- **demo.ts**: Canned cards/PRs shaped to match `jira.ts`/`github.ts` output, so demo mode runs the real `buildSnapshot` pipeline with no network.
- **actions.ts**: `applyAction()` — shared ack/move logic used by the HTTP handler (`POST /api/action`) and the CLI's `ack`/`move` commands, so the two transports can't drift on semantics. Also exports `BUCKETS`, the list of buckets a manual move can target (excludes `needs_attention`).
- **transport.ts**: Dual-transport primitives shared by the CLI and MCP server: `probeServer()` (is a real server answering on the configured port), `writePidFile()` (the writer half of the pid-file contract), `serverAppearsRunning()`/`saveStateGuarded()` (the split-brain guard for direct-mode writes — see Concurrency below).
- **ops.ts**: The dual-transport OPERATIONS built on those primitives — `opSnapshot`/`opRefresh`/`opAction`/`opWrite`, each deciding once between the HTTP proxy path (a live server's in-memory state is the source of truth) and the direct-disk path with the split-brain guards. The CLI and MCP handlers both consume these; callers own presentation only.
- **writeback.ts**: `performWrite()` — the single entry point for every write-back path (`POST /api/write`, the CLI's `transition`/`comment`/`pr-comment` commands, the MCP write tools). Builds the minimal ADF doc for Jira comments, re-reads `config.json` fresh on every call so `writeEnabled` takes effect without a restart, and refreshes the board after a successful write.
- **cli.ts**: `simon-dash` CLI (`status`/`refresh`/`ack`/`move`/`unpin`/`transition`/`comment`/`pr-comment`/`serve`/`open`). Argv parsing and output formatting only — the actual operations come from `ops.ts`, so the CLI and MCP server can't drift on transport semantics.
- **types.ts**: Shared types (Card, Pr, Item, Snapshot, State, Config, ActionResult, WriteResult) mirroring `web/src/types.ts`'s payload shapes.

### MCP (`mcp/`, TypeScript, erasable-syntax only, no build step)

A stdio MCP server exposing the board to Claude sessions, using the exact same dual-transport rule as the CLI (see `transport.ts` above and the Concurrency section below — MCP direct-mode writes go through the same split-brain guard).

- **handlers.ts**: Tool handler functions (`boardStatus`, `doRefresh`, `ackCard`, `moveCard`, `cardComments`, `transitionCard`, `commentCard`, `commentPr`), kept separate from the stdio wiring so they're callable directly in tests without a real MCP transport. All four operations delegate to `server/ops.ts` (the shared dual-transport layer, see below); this file only shapes tool results (summaries, untrusted-text notes) on top.
- **index.ts**: Registers the 8 tools above on an `McpServer` and connects a `StdioServerTransport`. Read tools (`board_status`, `refresh`, `ack_card`, `move_card`, `card_comments`) are always available; the three write tools (`transition_card`, `comment_card`, `comment_pr`) are real mutations gated by `writeEnabled` and always a no-op in demo mode, and their tool descriptions explicitly instruct the calling model to draft content and get the user's approval before calling them.

### Web (`web/src/`, Preact + TypeScript, Vite build)

- **main.tsx**: Entry point: mounts `<App>` wrapped in an `<ErrorBoundary>`.
- **app.tsx**: Top-level shell: live-update/refresh wiring, theme state (OS-aware), route branching (`/`, `/done`, 404), header, banners, toast. Acknowledging a Needs Attention card auto-advances the selection to the next such card.
- **notify.ts**: Desktop-notification rules for cards entering Needs Attention. Split like live-event.ts — `decideNotification()` is pure (keyed on card identity, not bucket length; skips the connect replay; only fires while the tab is hidden; always advances its baseline even when suppressed) and the Notification API calls sit below it.
- **use-data.ts**: `useData()` hook: holds an `EventSource` on `/api/events` for all data (initial render included), exposes `refresh()` for the manual button and `act()` for `/api/action` calls with error handling.
- **board.tsx**: `useBoardFilter()` hook (search/status/repo filter state, drag-and-drop handlers) plus `BoardStats`, `BoardFilterBar`, `BoardList` components.
- **detail.tsx**: Card detail side panel: a prominent status + next-action strip, Fix Version (with an explicit missing-state), PR/CI/review status, actionable New Jira Comments / New GitHub Comments queues, the per-source comment history behind "All Jira activity" / "All GitHub activity" disclosures, and ack/move actions.
- **extras.tsx**: Todo section, Unlinked PRs section, Recent Activity (grouped by merged/closed/comment).
- **done.tsx**: `/done` full-page sortable table of `doneCards` (cards Jira has marked Done). Replaces the former `/merged` and `/closed` pages.
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
     │                                buckets, todo, unlinkedPrs,
     │                                doneCards, recentActivity, prLog
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
  cards: { [jiraKey]: { lastSeenPr, lastSeenJira, override, overrideAt, ackedReasons, lastStatus } },
  celebrated: [{ id: "org/repo#num", at: isoString | null }],  // legacy, load-only (see below)
  doneCelebrated: [{ id: "jiraKey", at: isoString | null }],
  lastRefreshAt: isoString | null,
  snapshot: <last full payload, or null>,
  lastCards: <last successful Jira fetch, or null>,
  lastPrs: <last successful GitHub fetch, or null>,
  prLog: { [id]: { id, repo, openedAt, mergedAt, closedAt } }
}
```

- **cards**: per-card local overrides. `override`/`overrideAt` record a manual bucket pin; `lastSeenPr`/`lastSeenJira` are the comment "seen" horizons used by `classifyCard` to decide what counts as new; `ackedReasons` lists acknowledged state-based attention reasons (muted while continuously true); `lastStatus` is the card's Jira status as of the last refresh, compared each refresh to release a pin when the status transitions (#53). All are optional in pre-existing state files.
- **celebrated**: legacy PR-merge celebration ids from older state files. No longer written — completion is now tracked by Jira Done, not PR merges — but still read at load time so `migratePrLog` can backfill `prLog` history for pre-`prLog` state files.
- **doneCelebrated**: Jira cards observed in the Done category (keyed by card key), so the completion confetti only fires once per card. The `doneTotal` counter is not derived from it — it's `doneCards.length`, so the number always matches the Done list. Completion — not a PR merge — is what the UI celebrates and counts. Two rules keep this ledger honest, both learned the hard way:
  - **Only your own cards are appended.** Before `buildJql`'s assignee filter was fixed, the board fetched other people's cards and the refresh loop celebrated every Done one it saw — 25 foreign rows in permanent state. A fetch-layer bug must not be able to write state that outlives it, so the writer checks `card.assigneeId` against the configured account rather than trusting the fetch.
  - **Entries expire.** An entry's only job is preventing a second celebration, and it can only do that job while its card can still turn up in a fetch (`buildJql` bounds Done cards at `updated >= -14d`). An entry both absent from the current refresh and older than `CELEBRATION_RETENTION_DAYS` (90) is dropped, so the ledger stays bounded and a bad row ages out instead of needing a hand-run migration. Entries for cards in the *current* fetch are never dropped at any age: dropping one would re-celebrate that card on every subsequent refresh.
- **lastCards** / **lastPrs**: last-known-good fetch results, used to backfill the board on a partial or total source failure instead of blanking it.
- **prLog**: full PR lifecycle history (see API.md), upserted from every fetched PR each refresh; never pruned.
- **snapshot**: the exact payload the API returns; recomputed by `buildSnapshot` on every refresh, read as-is by `GET /api/data`.

### `.bak` rotation strategy

`saveState` only rotates the current `state.json` to `state.json.bak` if the current file parses as valid JSON. This protects against overwriting a good `.bak` with a corrupt one: if the current file is already corrupt (e.g. from a crash mid-write on a prior run), rotating it would destroy the one fallback `loadState` has. `loadState` itself: on a missing file, returns a fresh empty state (normal first run, no warning). On an unparseable file, it warns and falls back to `.bak`; if `.bak` is also unparseable, falls back to empty state.

Writes go through a temp file (`state.json.tmp`) and `renameSync`, so a crash mid-write never leaves a half-written `state.json` in place; the rename is atomic on the same filesystem.

## Classification rules

Evaluated top to bottom; the first matching row wins:

| Bucket | Condition |
|---|---|
| `self_review` | PR is open and a draft, and the card is not in a review status — otherwise always, even over attention triggers and overrides. |
| `needs_attention` | A visible **routing** attention trigger fires (`ci_failing` or `merged_not_in_test`; acked state-based reasons are muted while continuously true). Badge-only triggers never route (one exception: `new_jira_comments` on an In Test card — see the `qa_ready` row). |
| *(override)* | A manual-move override routes to its pinned bucket. Overrides auto-clear when the card's Jira status changes between refreshes (a transition supersedes the pin, #53) or once the card reaches In Test or Done, and are released explicitly by the `unpin` action. |
| `qa_ready` | Jira status equals the configured "In Test" status — unless `new_jira_comments` is visible, which routes the card to `needs_attention` instead: a Jira comment on a card in test is QA waiting on the developer, and the `lastSeenJira` watermark clears it (and returns the card here) as soon as the comment is read. |
| `waiting_review` | PR is open and a draft while the card is in a review status. Moving the card there is the operator saying it is out for peer review, so the draft stops holding it in Self Review Needed (#53). Checked before `mergeable`: a draft PR cannot be merged as it stands, however its reviews landed. |
| `mergeable` | PR is open and approved. |
| `waiting_review` | The card is in a review status ("Code Review"/"In Review", or `jira.statuses.review`; matched case-insensitively) — with or without a PR — or an open PR has any review activity. An approved or draft PR still wins. |
| `self_review` | PR is open with no review activity and the card isn't in a review status. |
| `in_progress` | Default: none of the above apply. |

`in_qa` is reachable only via a manual move (a pinned override) — the classifier itself never routes there.

Attention triggers are appended to `item.attention`, but only the **routing**
ones move the card. A card has a lifecycle state (its Jira status, its PR
state) and it has pending events; those are two independent axes. Only a
reason meaning *blocked or broken* may evict a card from the column its
lifecycle state earns it. Everything else rides along as a badge on the card
where it already is.

| Trigger | Routes? | Condition |
|---|---|---|
| `ci_failing` | yes | Linked PR is open and its CI status is `failing`. |
| `merged_not_in_test` | yes | Linked PR is merged but the Jira card's status is neither "In Test" nor "Done" yet. |
| `new_pr_comments` | badge | One or more GitHub PR comments from someone other than the configured username, newer than `cardState.lastSeenPr`. Renders as the "N new comments" pill. |
| `new_jira_comments` | badge | One or more Jira comments from someone other than the card's own author, newer than `cardState.lastSeenJira`. Same pill — except on an In Test card, where it routes to `needs_attention` (see the bucket table above). |
| `missing_qa_instructions` | badge | Card is in the configured "In Test" status and its description has no QA/test instructions. Renders as the "No QA Instructions" pill. |
| `missing_fix_version` | badge | Card is in the configured "In Test" status and has no fix version set. Renders as the "No Fix Version" pill, or "No Fix Version or QA" when both hand-off reasons fire. |

The routing set is `ROUTING_REASONS` in `classify.ts`. It exists because the
`Bucket` enum conflates both axes, so before the split any pending event had to
evict a card's state to be visible at all: one unread comment pulled a card out
of In Progress, and `missing_qa_instructions` — which is retroactive, since it
matches every In Test card that ever lacked instructions — emptied QA Ready into
Needs Attention the day it shipped. Acking still works on badge reasons: it
drops them from `item.attention`, which clears the pill.

Comments authored by anyone in `config.ignoreAuthors` (default `["John", "Rovo"]`, case-insensitive substring match) never fire `new_pr_comments`/`new_jira_comments` and never enter the actionable New Comments queue; they still appear in the full activity history.

A manual override (`type: 'move'`) is honored only when no *routing* attention trigger fires. The "live" triggers (CI failing, merged-not-in-test) always re-flag the card into `needs_attention` on the next refresh even if it was previously pinned elsewhere. Only the comment-based triggers are silenced by acking or moving, because those actions reset the seen horizon; CI status and merge state aren't horizon-gated, they're re-evaluated fresh every refresh.

Routing keys off the Jira **status category** (`new`/`indeterminate`/`done`), not exact status names, so `Assigned` counts as To Do and `Closed` as Done. Where a name *is* the only available signal (review status, In Test, Done, To Do, Canceled), every comparison goes through `sameStatus` in `classify.ts` — trimmed and lowercased, because a status name is free text an admin can re-case (#67). In order, before bucket classification:

1. **Canceled** cards (status matching `statuses.canceled`, default "Canceled") are dropped entirely — no bucket, no todo, no done, no counts.
2. **To Do category** cards are split into `todo` and skip classification.
3. **Done category** cards (excluding Canceled) are added to `doneCards`, and to `doneCelebrated` once if assigned to the configured account, then leave the board (skipping the bucket loop). Completion follows Jira's Done state, not the PR merge. `doneTotal` is `doneCards.length`, not the ledger size.
4. Everything else is classified into a bucket. A merged-but-not-Done card stays on the board (QA can still reject it) with the merged PR carried on the item's `pr` as context — there's no separate merged list.

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

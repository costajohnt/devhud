# API Reference

simon-dash exposes a small local HTTP API on `127.0.0.1` (loopback only, not reachable from other machines). There is no authentication: anyone with access to the machine and port can call it. Five endpoints under `/api/`, plus static file serving for the SPA.

There are two other ways to reach the same board: `server/cli.ts` (a plain-TS CLI, see the README's CLI section) and `mcp/` (a stdio MCP server for Claude sessions, see the README's Claude integration section). Both use the same dual-transport rule as this API: proxy through a running server when one's up, otherwise operate directly on `data/state.json` via the same server modules this API uses, so behavior is identical across all three.

## GET /api/data

Returns the last computed snapshot from memory. Does not touch Jira or GitHub; it's a cheap read of whatever `/api/refresh` last produced.

If the server has never run a refresh (fresh `data/state.json`, no snapshot yet), it returns a placeholder shape instead of `null`:

```json
{
  "updatedAt": null,
  "errors": { "jira": null, "github": null },
  "buckets": { "needs_attention": [], "in_progress": [], "self_review": [], "waiting_review": [], "mergeable": [], "qa_ready": [], "in_qa": [] },
  "todo": [], "unlinkedPrs": [],
  "doneCards": [], "doneTotal": 0, "newlyDone": [], "recentActivity": [],
  "prLog": []
}
```

This placeholder carries every top-level key a real snapshot has (empty arrays/zeros in place of real data), so callers — the web client, the CLI's direct-mode `status` — never have to special-case true first boot before any refresh has ever run.

## GET /api/events

Server-Sent Events stream of snapshots. On connect the server immediately sends the current snapshot (same shape and placeholder rules as `GET /api/data`), then pushes a new event after every refresh — the server's own scheduled refresh loop (see `refreshIntervalSeconds` in the README), a manual `POST /api/refresh`, or a successful write — and after every `POST /api/action` mutation. Each event is one `data:` line holding the full snapshot JSON.

A refresh whose content is identical to the last broadcast (only `updatedAt` moved) is not re-sent in full; instead the stream carries a named `tick` event whose data is `{ "updatedAt": "..." }`, so clients can keep their "last checked" display current without re-rendering an unchanged board.

This is what makes the web UI live: the client holds one `EventSource` open instead of polling, so every open tab re-renders within one server tick of anything changing, and background-tab timer throttling doesn't matter.

## POST /api/refresh

Fetches fresh data from Jira and GitHub (or generates canned data in demo mode, see Demo Mode below), rebuilds the snapshot, persists state to disk, and returns the new snapshot. The server's own scheduled loop runs this same pipeline on an interval, and `POST /api/write` also reaches Jira/GitHub — this is just the only way to *request* a fetch.

No request body. Response is the full payload described in Payload Shape.

## POST /api/action

Applies a manual action to one card. Body is JSON:

```json
{ "type": "ack", "key": "PROJ-123" }
```

or

```json
{ "type": "move", "key": "PROJ-123", "bucket": "in_qa" }
```

or

```json
{ "type": "unpin", "key": "PROJ-123" }
```

### `type: "ack"`

Acknowledges a card's attention flags:

- Clears `item.attention` and `item.newComments` on the in-memory snapshot.
- Resets the "seen" horizon (`cardState.lastSeenPr` and `lastSeenJira`) to the *data horizon*, not wall-clock time: the last snapshot's `updatedAt`. This matters because a comment that arrived between the last refresh and this ack must still be treated as new on the *next* refresh, not silently swallowed.
- If the card was in `needs_attention`, moves it out: to its existing override bucket if one is set (`cardState.override`), otherwise to wherever the classifier would put it — the same order `classifyCard` uses, including the draft-PR rule that outranks everything else. (Both this and `unpin` call one shared `classifierDest` helper, so an acked card can't land somewhere the next refresh immediately undoes.)
- Does **not** clear a prior override. Acking only dismisses the attention flags; it doesn't undo a previous manual move — that's what `unpin` is for.

### `type: "move"`

Pins a card to a specific bucket:

- `bucket` must be one of `in_progress`, `self_review`, `waiting_review`, `mergeable`, `qa_ready`, `in_qa`. Moving to `needs_attention` is rejected (see 400 cases below). That bucket is server-computed only, not a manual destination.
- Sets `cardState.override` to the target bucket and stamps `overrideAt`.
- Also resets the seen horizon (same as `ack`), so comments the classifier already accounted for don't immediately bounce the card back into `needs_attention` on the very next refresh.
- Splices the card out of its current bucket in the live snapshot and into the target bucket.

The override persists across refreshes: on every `/api/refresh`, `classifyCard` checks `cs.override` and honors it unless a "live" attention trigger fires again (CI failing, a merged-not-in-test card, or a new unseen comment); see Buckets below.

### `type: "unpin"`

Releases a manual pin and hands the card back to classifier control:

- Clears `cardState.override` and `overrideAt`.
- Re-derives the card's bucket from its current state via the same `classifierDest` helper `ack` uses, and splices it there in the live snapshot. A card whose attention triggers are still live unpins back into `needs_attention` rather than being pulled out of triage — `classifyCard` checks attention before override, so a pinned card can legitimately sit there.
- Does **not** touch the seen horizons. Unpinning says "stop forcing this bucket", not "I've read the new comments"; conflating the two would silently mark unread activity as seen.
- Responds with `wasPinned`, distinguishing a released pin from a card that had none: `{ "ok": true, "bucket": "in_progress", "wasPinned": false }`. Unpinning an unpinned card is a successful no-op, not an error.
- A card not on the current board still gets its stored override cleared, and responds `bucket: null`.

Before this existed, `override` was effectively write-only: drag-to-pin and `move` set it, and the only exits were the card reaching In Test/Done (`classifyCard`'s auto-clear) or hand-editing `data/state.json`.

### Required fields

`key` is required for every action type (a Jira issue key). `type` must be `"ack"`, `"move"`, or `"unpin"`.

### 400 cases

- Body is not valid JSON: `{ "error": "invalid JSON body" }`.
- `type: "move"` with `bucket` not in the six movable buckets (including `needs_attention`): `{ "error": "bucket must be one of in_progress, self_review, waiting_review, mergeable, qa_ready, in_qa" }`.
- `type` is anything other than `"ack"`, `"move"`, or `"unpin"`: `{ "error": "unknown action type" }`.

An action against an unknown `key` (a card not present in any bucket, or never seen before) does not 400. `cardState` is created lazily and the horizon fields are still written to `data/state.json`, but there's no matching snapshot item to move, so the action is a no-op on the visible board. This is intentional: it makes acking a card that just left the board (e.g. Jira marked it Done and it moved to `doneCards` between page load and the click) harmless instead of an error.

On success, every action type responds `{ "ok": true, "bucket": string | null }` — `bucket` is the card's resulting bucket, or `null` if it isn't on the current board (see the unknown-`key` case above) — and persists `data/state.json` before returning. `unpin` adds a `wasPinned` boolean.

## POST /api/write

The only endpoint that mutates Jira or GitHub. Off by default: gated by `writeEnabled` in `config.json` (see server/writeback.ts's `checkWriteGate`). Body is JSON, one of:

```json
{ "type": "transition", "key": "PROJ-123", "status": "In Review" }
{ "type": "comment", "key": "PROJ-123", "body": "plain text comment" }
{ "type": "pr_comment", "repo": "acme/webapp", "number": 482, "body": "plain text comment" }
```

- `type: "transition"` — fetches the card's available Jira transitions and posts the one whose destination status (`to.name`) matches `status`, case-insensitively. Errors (400) if no transition to that status is available, listing the available destination status names.
- `type: "comment"` — posts `body` as a Jira comment, wrapped in a minimal ADF (Atlassian Document Format) doc (a single paragraph, no formatting).
- `type: "pr_comment"` — posts `body` as a plain-text comment on the given PR via GitHub's issue-comments API.

Gate semantics:

- `writeEnabled: false` (the default) outside demo mode: `403`, `{ "error": "write-back disabled; set writeEnabled: true in config.json" }`. Nothing is written, nothing is refreshed.
- Demo mode: **always** refuses, regardless of `writeEnabled` — there's nothing real to write to. Unlike the case above this is `200`, not `403`: `{ "ok": true, "demo": true, "message": "demo mode: write-back is a no-op (nothing real to write to)" }`. It's a stub success, not an error, because nothing is misconfigured.
- Unknown `type`, or missing required fields for the given `type`: `400`.
- A target outside the dashboard's own scope: `403`. `key` must start with the configured `jira.projectKey` (`{ "error": "key \"OTHER-1\" is outside the configured project PROJ" }`), and `repo` must be a member of the configured `github.repos` list, normalized the same way `fetchPrs` normalizes it — a bare `name` entry is read as `<org>/<name>`, an `owner/name` entry is taken as-is (`{ "error": "repo \"o/not-mine\" is not in the configured github.repos list" }`). This is a *scope* check, distinct from the syntax check below: the well-formed key `OTHER-1` passes validation and still fails here. It exists because the MCP surface hands these tools to a model reading third-party Jira/GitHub text, so "well-formed" is not the same question as "a resource this dashboard manages".
- A malformed `key` (not `ABC-123` shaped) or `repo` (not `owner/name` shaped), or a non-integer PR number: `400`.
- The underlying Jira/GitHub call failing (bad key, no matching transition, network error): `502`, with the upstream error message.
- The config re-read itself failing (file deleted or unreadable mid-edit): `403`, refusing the write rather than falling back to an in-memory config — see the fail-closed note above.

On a real success (`writeEnabled: true`, not demo, the write succeeded), the server immediately runs the same refresh pipeline `/api/refresh` uses (so the board reflects the change without waiting for the next poll), persists `data/state.json`, and responds `{ "ok": true, ...writeSpecificFields }` — e.g. `{ "ok": true, "transitionedTo": "In Review" }` for a transition.

The CLI (`simon-dash transition|comment|pr-comment`) and the MCP write tools (`transition_card`/`comment_card`/`comment_pr`) both go through this same endpoint when a server is running, and through the same `performWrite()` function directly on disk when one isn't — so gate semantics and the post-write refresh can't drift between the three surfaces.

## Payload shape

The full snapshot returned by `/api/refresh` and (once populated) `/api/data`:

```
{
  updatedAt: string,               // ISO timestamp of this snapshot
  errors: { jira: string | null, github: string | null },
  buckets: {
    needs_attention: Item[], in_progress: Item[], self_review: Item[], waiting_review: Item[], mergeable: Item[], qa_ready: Item[], in_qa: Item[]
  },
  todo: TodoItem[],
  unlinkedPrs: UnlinkedPr[],
  doneCards: DoneCard[],           // cards Jira has marked Done — drives the /done page
  doneTotal: number,               // doneCards.length — the "Done" counter
  newlyDone: string[],             // cards that reached Done on this refresh — drives confetti
  recentActivity: ActivityEntry[], // merged/closed/comment activity in the last 7 days
  prLog: PrLogEntry[]
}
```

### Item (board card)

```
{
  key: string,                     // Jira issue key, e.g. "PROJ-123"
  summary: string,
  jiraStatus: string,               // raw Jira status name
  jiraUrl: string,
  fixVersions: string[],            // Jira Fix Version names; empty array = none set (flagged in the detail view)
  bucket: 'needs_attention' | 'in_progress' | 'self_review' | 'waiting_review' | 'in_qa',
  attention: string[],              // trigger reasons: 'ci_failing', 'new_pr_comments', 'new_jira_comments', 'merged_not_in_test'
  newComments: Comment[],           // comments newer than the seen horizon, from others (not self)
  comments: Comment[],              // full comment history, both sources merged, newest first, capped at 10
  pr: PrRef | null,
  createdAt: string,                // Jira card created
  updatedAt: string,                // Jira card updated
  daysSinceActivity: number | null  // days since max(card.updatedAt, pr.updatedAt)
}
```

`newComments` and `comments` are deliberately separate, not one filtered from the other:

- `newComments` is seen-horizon-filtered (only comments after `cardState.lastSeenPr`/`lastSeenJira`, excluding the card owner's own comments) and drives the `attention` flags and the Detail panel's "New Jira Comments" / "New GitHub Comments" sections.
- `comments` is the last-10-per-source comment history (up to 20 total, merged newest first) regardless of seen status, for the Detail panel's per-source activity disclosures, so you can read context even after acking.

`Comment`:

```
{ source: 'github' | 'jira', author: string, body: string, createdAt: string }
```

`body` is truncated to 300 characters at the source (`refresh.ts`/`classify.ts`), not on the client.

`PrRef` (a trimmed view of the linked PR, `null` if the card has no linked PR):

```
{ repo: string, number: number, url: string, branch: string, state: 'open' | 'merged' | 'closed', ciStatus: 'passing' | 'failing' | 'pending' | 'unknown', reviewState: 'review_required' | 'changes_requested' | 'approved' | 'none' }
```

### TodoItem

```
{ key: string, summary: string, jiraUrl: string, createdAt: string }
```

Cards whose Jira status is the configured "To Do" status. Split out before bucket classification runs; never appear in `buckets`.

### UnlinkedPr

```
{ repo: string, number: number, url: string, title: string, state: string }
```

Open PRs that couldn't be matched to any tracked Jira card by branch name, PR title, PR body (containing a `/browse/KEY` link), or card description (containing the PR URL). Only `state === 'open'` unlinked PRs are surfaced; unlinked merged/closed PRs are silently dropped from this list (they still land in `prLog`).

### DoneCard

```
{ key: string, summary: string, jiraStatus: string, jiraUrl: string, pr: PrRef | null, doneAt: string }
```

Cards Jira has marked complete — status category `done`, excluding Canceled. Drives the `/done` page and the header's Done counter. `doneAt` is the card's last-updated time (when it reached Done); `pr` is the linked PR, if any, as supporting context. Completion follows the **Jira card's Done state**, not a PR merge — a merged-but-not-Done card stays on the active board with its merged PR shown as context.

There is no Merged or Closed page/counter/field. A merged PR surfaces only on its active card (the board's "Merged" pill and the detail panel's "PR merged" chip) and, for merges/closes in the last 7 days, in `recentActivity`.

### doneTotal / newlyDone

`doneTotal` is `doneCards.length` — the number of Done cards in the current fetch window, so the header counter always matches the `/done` list it labels. It is not an all-time total: cards that age out of Jira's fetch window (or stop matching the board's JQL) leave both the list and the count.

`newlyDone` is the list of Jira keys that reached Done on *this* refresh only, empty on every refresh after the first celebration. Drives the completion confetti/toast in the UI.

### recentActivity

Flat list across three types, all within the last 7 days, newest first:

```
{ type: 'merged' | 'closed' | 'comment', label: string, url: string, date: string }
```

- `merged`: PRs with `mergedAt` in the last 7 days.
- `closed`: closed-unmerged PRs (`state === 'closed'`, no `mergedAt`) with `updatedAt` in the last 7 days, derived straight from the fetched PRs.
- `comment`: derived from each board item's `newComments` (not a separate scan): any unseen comment newer than 7 days, `label` is `"{key}: comment from {author}"`, `url` points at the PR if the comment is from GitHub, otherwise the Jira card.

### prLog (PR lifecycle log)

```
{ id: string, repo: string, openedAt: string | null, mergedAt: string | null, closedAt: string | null }
```

One entry per PR ever fetched, keyed by `org/repo#number` (`id`). Upserted (not appended) on every refresh, real or demo, from the live fetched PR list: `openedAt` from `createdAt`, `mergedAt` as-is, `closedAt` only when `state === 'closed'` and there's no `mergedAt` (a merged PR never carries `closedAt`). Entries are never deleted, so this is a full history, not just what's currently open. Powers the Monthly Activity line chart (Opened/Merged/Closed series) and the Top Repos stacked bar chart in the web UI. States created before this field existed get a synthesized entry per legacy `celebrated` merge (`openedAt`/`closedAt` unknown, only `mergedAt` recoverable).

`state.doneCelebrated` has the same append-only, unbounded character as `prLog` below: one `{ id, at }` entry per card that has ever reached Done, never pruned. It's much smaller per entry and isn't part of the payload, but it does grow every `state.json` write forever.

**Known limitation: `prLog` is append-only and unbounded.** There is no eviction, no age-based pruning, and no cap on entry count — every PR the account has ever had fetched into it (across every repo in `github.repos`, for as long as `data/state.json` has existed) stays in `prLog` forever, growing `state.json` and the `/api/data`/`/api/refresh` payload size a little more with each newly-seen PR. For a single-user personal tool at realistic PR volumes this is a non-issue in practice, but it's a real limitation if this ever needs to scale to a high-volume repo or run unattended for years.

## Error semantics

`errors.jira` and `errors.github` are independent, both null on a clean refresh. A refresh never blanks the board on a source failure:

- If Jira fetch throws, `errors.jira` is set to the error message and `cards` falls back to `state.lastCards` (the last successful fetch), so the board keeps showing what it had.
- If the GitHub PR list fetch fails per-repo (one bad repo shouldn't blank the others), that repo's error is appended into `errors.github`, and that repo's PRs are spliced back in from `state.lastPrs`.
- If enriching an individual linked PR (comments/CI/review detail) rejects, `errors.github` gets the failure message appended, and that one PR falls back to its `state.lastPrs` counterpart (matched by repo + number) rather than losing its CI/review/comment data.
- If the whole GitHub fetch step throws unexpectedly, `errors.github` is set and `prs` falls back to `state.lastPrs` wholesale.

`errors` on the payload always reflects the current refresh's outcome (not accumulated across refreshes); a clean refresh after a failed one resets both back to `null`.

## Request guards and status codes

Guards that apply across routes, rather than to one endpoint. A client written only against the per-endpoint sections above will otherwise meet these as surprises.

| Code | When | Body |
| --- | --- | --- |
| `403` | **Every** `/api/*` route, reads included: the `Host` header is not `127.0.0.1:<port>` or `localhost:<port>` (the port the connection actually landed on). | `{ "error": "invalid Host header" }` |
| `415` | `POST /api/refresh`, `/api/action`, `/api/write`: `Content-Type` is not `application/json`. | `{ "error": "Content-Type must be application/json" }` |
| `413` | `POST /api/action`, `/api/write`: request body exceeded the 1 MB cap. | `{ "error": "body too large" }` |
| `400` | `POST /api/action`, `/api/write`: body is not parseable JSON (distinct from the size cap above). | `{ "error": "invalid JSON body" }` |
| `503` | `GET /api/events`: 32 event streams are already open. | `{ "error": "too many event streams" }` |
| `500` | Any unhandled error. The real error (which can carry filesystem paths) is logged server-side only. | `{ "error": "internal error" }` |

The `Host` check is DNS-rebinding protection, and it covers reads for a reason: binding to `127.0.0.1` does not defend against rebinding on its own, and a read-only endpoint is exactly what a rebinding attack targets (confidentiality, not mutation). The `Content-Type` requirement is the CSRF gate — none of the CORS-safelisted content types qualify as JSON, so a cross-origin caller needs a preflight, and this server never sends `Access-Control-Allow-Origin`.

Static responses (not `/api/*`) additionally carry `X-Content-Type-Options: nosniff` and a `Content-Security-Policy` restricting scripts, styles, images, and connections to `'self'` with `frame-ancestors 'none'`. The policy allows `'unsafe-inline'` (required by the pre-paint theme script and inline style attributes), so it buys exfiltration resistance and framing protection rather than inline-injection protection; Preact's text escaping remains the primary XSS defense.

## Static serving and SPA fallback

Any request not starting with `/api/` is treated as a static file request against `webDist` (the built `web/dist` directory):

- Path traversal is blocked: the resolved path must stay within `webDist`, otherwise the server responds `403`.
- If the resolved path is a real file, it's served with a `content-type` derived from its extension (`.html`, `.js`, `.css`, `.svg`, `.woff2`, `.png`, `.json`; anything else falls back to `application/octet-stream`).
- If the path doesn't resolve to a file (a client-side route like `/done`, or any unknown path), the server falls back to serving `index.html` so the SPA router (`preact-iso`, reading `window.location` client-side) can render its own not-found or route view.

`/api/*` paths that don't match `/api/data`, `/api/events`, `/api/refresh`, `/api/action`, or `/api/write` (wrong method or unknown path) return `404` with `{ "error": "not found" }` instead of falling through to the SPA.

## Single-instance behavior

The server binds `127.0.0.1:<port>` (loopback only, not reachable from other hosts on the network) via `http.Server#listen`. If another instance is already bound to that port, `listen` fails with `EADDRINUSE`; the server logs `already running on port <port>` and exits with code 1, rather than probing a pid file (a pid file can false-negative after a crash, or false-positive if the pid was reused by an unrelated process). On successful bind, a `data/server.pid` file is written with `{ pid, port, startedAt }` for operator convenience (not used for the instance check itself), and removed on `SIGINT`/`SIGTERM`.

## CLI

`server/cli.ts` exposes `status`/`refresh`/`ack`/`move`/`transition`/`comment`/`pr-comment`/`serve`/`open` over this same API surface without a browser. Its core design is dual transport: it probes `GET /api/data` on `127.0.0.1:<port>` with a ~500ms timeout, and if that succeeds it drives every command through the HTTP endpoints documented above (so a running server's live in-memory state is the one read/mutated); if nothing answers, it operates directly on `data/state.json` via the same `loadState`/`saveState`/`refresh`/`applyAction` modules the server itself uses, so behavior is identical either way — that branch is chosen once per command in `server/ops.ts`, which both the CLI and the MCP server consume, and `ack`/`move` semantics in particular come from a single shared `applyAction` function (`server/actions.ts`) that both the HTTP handler and the CLI call, so the two transports can never drift. Which transport was used is always printed to stderr in human-readable mode. See the README's CLI section for usage examples.

## Demo mode

Set `"demo": true` in `config.json`, or run with `SIMON_DASH_DEMO=1` in the environment (`JIRA_DASH_DEMO=1` still works as a deprecated alias). In demo mode, `/api/refresh` skips Jira and GitHub entirely and imports canned data from `server/demo.ts` (`demoCards`/`demoPrs`), shaped to match what `jira.ts`'s `mapIssue` and `github.ts`'s `mapPr` (post-enrichment) would produce. That canned data runs through the same `buildSnapshot` pipeline as real data (classification, linking, `prLog` upsert, everything), so demo mode exercises the real logic end to end with no network calls and no credentials required. `errors.jira`/`errors.github` are always `null` in demo mode.

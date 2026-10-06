# API Reference

simon-dash exposes a small local HTTP API on `127.0.0.1` (loopback only, not reachable from other machines). There is no authentication: anyone with access to the machine and port can call it. Seven routes under `/api/` (`/api/data`, `/api/events`, `/api/refresh`, `/api/action`, `/api/write`, `/api/simon/runs` and `/api/simon/runs/:id`), plus static file serving for the SPA.

There are two other ways to reach the same board: `server/cli.ts` (a plain-TS CLI, see the README's CLI section) and `mcp/` (a stdio MCP server for Claude sessions, see the README's Claude integration section). Both use the same dual-transport rule as this API: proxy through a running server when one's up, otherwise operate directly on `data/state.json` via the same server modules this API uses, so behavior is identical across all three.

## GET /api/data

Returns the last computed snapshot from memory. Does not touch Jira or GitHub; it's a cheap read of whatever `/api/refresh` last produced.

If the server has never run a refresh (fresh `data/state.json`, no snapshot yet), it returns a placeholder shape instead of `null`:

```json
{
  "updatedAt": null,
  "errors": { "jira": null, "github": null },
  "buckets": { "needs_attention": [], "in_progress": [], "self_review": [], "waiting_review": [], "mergeable": [], "qa_ready": [], "in_qa": [] },
  "todo": [], "blocked": [], "unlinkedPrs": [],
  "doneCards": [], "doneTotal": 0, "newlyDone": [], "recentActivity": [],
  "prLog": [], "filed": []
}
```

This placeholder carries every top-level key a real snapshot has (empty arrays/zeros in place of real data), so callers — the web client, the CLI's direct-mode `status` — never have to special-case true first boot before any refresh has ever run.

## GET /api/events

Server-Sent Events stream of snapshots. On connect the server immediately sends the current snapshot (same shape and placeholder rules as `GET /api/data`), then pushes a new event after every refresh — the server's own scheduled refresh loop (see `refreshIntervalSeconds` in the README), a manual `POST /api/refresh`, or a successful write — and after every `POST /api/action` mutation. Each event is one `data:` line holding the full snapshot JSON.

A refresh whose content is identical to the last broadcast (only `updatedAt` moved) is not re-sent in full; instead the stream carries a named `tick` event whose data is `{ "updatedAt": "..." }`, so clients can keep their "last checked" display current without re-rendering an unchanged board.

Slow consumers are disconnected rather than buffered. If a stream stops reading (e.g. a suspended laptop tab whose socket buffer is full) and more than 4 MB of unsent events have queued for it by the time the next event is due, the server closes the stream instead of queueing more. Brief stalls under that bound are buffered and delivered normally. Clients should reconnect, as `EventSource` does by itself and the web UI does with backoff. Nothing is lost: every new connection starts with the current snapshot.

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

The override persists across refreshes: on every refresh, `classifyCard` checks `cs.override` and honors it unless something that outranks a pin applies. Two things do. One is an open draft PR on a card that is not in a review status, which routes to `self_review`. The other is a visible **routing** attention reason, which routes to `needs_attention`. The routing reasons are `ROUTING_REASONS` in `classify.ts`: `ci_failing` and `merged_not_in_test`. A new comment does **not** override a pin: `new_pr_comments`/`new_jira_comments` are badge reasons, so they show as a pill on the pinned card and leave it in its bucket. See the classification rules in [ARCHITECTURE.md](ARCHITECTURE.md#classification-rules).

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

The only endpoint that mutates Jira or GitHub (the one other write path is the opt-in `autoTransitionMerged` tick, see Config notes below). Off by default: gated by `writeEnabled` in `config.json` (see server/writeback.ts's `checkWriteGate`). Body is JSON, one of:

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

### Config notes

Keys in `config.json` that change what reaches Jira or GitHub, all re-read from disk on every write (fail closed if the read fails):

- `writeEnabled` (default `false`): the master gate described above. Nothing writes while it is `false`.
- `demo` (default `false`): when `true`, every write is a stub success and nothing is written, regardless of `writeEnabled`.
- `autoTransitionMerged` (default `false`): opt-in automatic transitions. After each scheduled refresh tick (the server's own loop, not `POST /api/refresh`), `autoTransitionMergedCards()` in `server/writeback.ts` moves cards flagged `merged_not_in_test` to `jira.statuses.inTest`. It does not go through this endpoint: it calls the Jira transition directly so the write doesn't trigger a second refresh. It shares this endpoint's gates. It does nothing unless `writeEnabled` is `true`, refuses in demo mode, and only touches keys inside `jira.projectKey`. It also skips cards whose `merged_not_in_test` reason is acked. Further guards:
  - It skips the batch when the refresh's data is degraded (`errors.jira` or `errors.github` set).
  - It only moves a card out of a review or in-progress status (`jira.statuses.inProgress`, default "In Progress", or the review status), never out of To Do or a status past In Test.
  - Immediately before each transition it re-reads the issue's live status (`GET /rest/api/3/issue/{key}?fields=status`). It proceeds only if that status is still pre-test and is the same status the snapshot saw (case-insensitive). Otherwise it skips the card without transitioning and records the skip in `state.autoTransitioned` (`{ ok: false, skipped: true, error: "status changed: X -> Y" }`) so it is not re-checked every tick. If the status GET fails, nothing is transitioned or recorded, and the card is re-checked next tick.
  - It fires at most once per merged PR. Failures are remembered rather than retried every tick.
  - It never re-flags a card that QA sent back after the card had reached In Test.

  Per-card failures are logged and the batch continues. It never comments and never writes to GitHub.

## GET /api/simon/runs

Lists Simon executor runs. Read-only, served on demand, and outside the snapshot/SSE cycle, so run telemetry never rides along on `/api/events`. Implemented in `server/simon.ts`.

Needs the optional `simon` block in `config.json`:

```json
"simon": { "root": "/absolute/path/to/simon/scaffold", "bin": "simon" }
```

`root` must be an absolute path (`loadConfig` rejects a relative one). `bin` is optional and defaults to `simon`. Without the block the response is `{ "configured": false, "runs": [] }`, and the web UI's `/simon` page shows an "unconfigured" card.

When configured, the server reads every `<root>/state/runs/*.jsonl` ledger and returns:

```
{
  configured: true,
  runs: SimonRunSummary[],   // newest first (ids are timestamp-prefixed)
  statusError?: string       // set when `simon status --json` failed; classes then come from the ledger fallback
}
```

`SimonRunSummary`:

```
{
  id: string,               // ledger basename minus .jsonl: <UTC-ts>-<KEY>
  key: string,              // work-item key from run_start (fallback: parsed from id)
  startedAt: string | null,
  endedAt: string | null,   // run_end ts, null while in flight
  outcome: string | null,   // run_end outcome
  haltedAt: string | null,  // run_end halted_at
  phase: string | null,     // last phase_start's phase
  class: string | null,     // attention class (see below)
  durationS: number | null,
  lastEventAt: string | null
}
```

`class` comes from `<bin> status --json` (run with `SIMON_ROOT=<root>` and a 5s timeout), attached to the newest run per key only. When that command fails, or has nothing for a run, the class falls back to the ledger: a finished run gets its `outcome`, an unfinished one is `in_flight`, or `stale` once its last event is more than 10 minutes old. A missing runs directory is not an error, it returns `runs: []`. Malformed ledger lines and unreadable ledgers are skipped.

## GET /api/simon/runs/:id

Returns one run's parsed ledger: `{ id: string, key: string, events: SimonEvent[] }`, where each event is one JSONL line with at least `ts` and `event` and every other field passed through verbatim. All timeline interpretation happens client-side (`web/src/simon-run-fold.ts`). The web UI's `/simon/<id>` page re-polls this every 1.5s while the run has no `run_end`.

`404 { "error": "run not found" }` when `simon` is not configured, when the id fails `^[A-Za-z0-9._-]+$` (or is malformed percent-encoding such as `%zz`), when the resolved path would leave the runs directory, or when no such ledger exists.

## Payload shape

The full snapshot returned by `/api/refresh` and (once populated) `/api/data`:

```
{
  updatedAt: string | null,        // ISO timestamp of this snapshot (null only in the first-boot placeholder)
  errors: { jira: string | null, github: string | null },
  buckets: {
    needs_attention: Item[], in_progress: Item[], self_review: Item[], waiting_review: Item[], mergeable: Item[], qa_ready: Item[], in_qa: Item[]
  },
  todo: TodoItem[],
  blocked: TodoItem[],              // Jira Blocked cards, split out like todo
  unlinkedPrs: UnlinkedPr[],
  doneCards: DoneCard[],           // lifetime ledger of cards Jira has marked Done, newest first — drives the /done page
  doneTotal: number,               // doneCards.length (the lifetime ledger's size) — the "Done" counter
  newlyDone: string[],             // cards that reached Done on this refresh — drives confetti
  recentActivity: ActivityEntry[], // merged/closed/comment activity in the last 7 days
  prLog: PrLogEntry[],
  filed: FiledCard[]               // cards this user reported, newest first — drives the /filed page
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
  bucket: 'needs_attention' | 'in_progress' | 'self_review' | 'waiting_review' | 'mergeable' | 'qa_ready' | 'in_qa',
  attention: string[],              // visible reasons: 'ci_failing', 'merged_not_in_test' (routing),
                                    // 'new_pr_comments', 'new_jira_comments', 'missing_qa_instructions', 'missing_fix_version' (badges)
  newComments: Comment[],           // comments newer than the seen horizon, from others (not self)
  comments: Comment[],              // comment history, last 10 per source, merged newest first
  pr: PrRef | null,
  createdAt: string | null,         // Jira card created (null if Jira's timestamp was unparseable)
  updatedAt: string | null,         // Jira card updated (same)
  daysSinceActivity: number | null, // days since max(card.updatedAt, pr.updatedAt)
  pinned: boolean,                  // a manual pin (cardState.override) is holding the card in this bucket
  pinnedAt: string | null           // when that pin was set (cardState.overrideAt)
}
```

`newComments` and `comments` are deliberately separate, not one filtered from the other:

- `newComments` is seen-horizon-filtered (only comments after `cardState.lastSeenPr`/`lastSeenJira`, excluding the card owner's own comments) and drives the `attention` flags and the Detail panel's "New Jira Comments" / "New GitHub Comments" sections.
- `comments` is the last-10-per-source comment history (up to 20 total, merged newest first) regardless of seen status, for the Detail panel's per-source activity disclosures, so you can read context even after acking.

`Comment`:

```
{ source: 'github' | 'jira', author: string, body: string, createdAt: string | null }
```

`body` is truncated to 300 characters at the source (`refresh.ts`/`classify.ts`), not on the client.

`PrRef` (a trimmed view of the linked PR, `null` if the card has no linked PR):

```
{ repo: string, number: number, url: string, branch: string, state: 'open' | 'merged' | 'closed', ciStatus: 'passing' | 'failing' | 'pending' | 'unknown', reviewState: 'review_required' | 'changes_requested' | 'approved' | 'none', ciNewFailures?: string[], ciBasePending?: boolean, isDraft?: boolean }
```

`ciNewFailures` is present only while `ciStatus` is `'failing'`: the failed checks that are not also failing on the PR's base branch. `[]` means every failure is pre-existing on the base, so the card gets no `ci_failing` reason; absent means the comparison was not possible and the card is flagged as before, unless `ciBasePending` is `true`: the base branch's CI is still running, so the verdict is unknown and the card is not flagged (refresh carries over the previous verdict for the same PR when it has one). The board shows such a PR as "CI red, base running".

`isDraft` is `true` for a GitHub draft PR and for a PR carrying a `Draft` label (how Simon marks the PRs it opens). An open draft routes the card to `self_review` unless the card is in a review status, and never to `mergeable`.

### TodoItem

```
{ key: string, summary: string, jiraUrl: string, createdAt: string | null }
```

Cards in Jira's To Do status category (or the configured "To Do" status) with no linked PR. Split out before bucket classification runs; never appear in `buckets`. A To Do card that already has a linked PR stays on the board. `blocked` uses the same shape for cards in the Blocked status, which leave the board whether or not they have a PR.

### UnlinkedPr

```
{ repo: string, number: number, url: string, title: string, state: string }
```

Open PRs that couldn't be matched to any tracked Jira card by branch name, PR title, PR body (containing a `/browse/KEY` link), or card description (containing the PR URL). Only `state === 'open'` unlinked PRs are surfaced; unlinked merged/closed PRs are silently dropped from this list (they still land in `prLog`).

### DoneCard

```
{ key: string, summary: string, jiraStatus: string, jiraUrl: string, pr: PrRef | null, doneAt: string | null }
```

Cards Jira has marked complete — status category `done`, excluding Canceled. Drives the `/done` page and the header's Done counter. The list is a lifetime ledger (`state.doneLedger`), not one fetch: see doneTotal below. `doneAt` is the card's last-updated time (when it reached Done); `pr` is the linked PR, if any, as supporting context. Completion follows the **Jira card's Done state**, not a PR merge — a merged-but-not-Done card stays on the active board with its merged PR shown as context.

There is no Merged or Closed page/counter/field. A merged PR surfaces only on its active card (the board's "Merged" pill and the detail panel's "PR merged" chip) and, for merges/closes in the last 7 days, in `recentActivity`.

### filed

```ts
{ key: string, summary: string, jiraStatus: string, jiraUrl: string, createdAt: string | null }
```

Every card whose Jira **reporter** is the configured `accountId`, site-wide (not limited to `projectKey`) and in any status, ordered by `created` descending. A second JQL query per refresh, incremental: it fetches only recently updated cards and merges them into the previous list. A full refetch runs every 24 hours (and immediately when `jira.accountId` or `jira.baseUrl` changes), which drops deleted or moved cards. If the query fails, the previous list is kept (or emptied after an account/site change) and the failure is appended to `errors.jira`. Drives the "Filed by me" stat card and the `/filed` page.

### doneTotal / newlyDone

`doneTotal` is `doneCards.length`, so the header counter always matches the `/done` list it labels. Both come from `state.doneLedger`, a lifetime ledger of Done cards, so the count is all-time and does not shrink as cards age. Done cards are fetched incrementally against a watermark: `doneWatermark()` in `jira.ts` takes the newest `doneAt` in the ledger minus one day (date-only, since Jira evaluates a bare date in the user's timezone), and the board's JQL fetches Done cards only from that date on. Each refresh merges what it fetched into the ledger by key (this refresh's row wins) and evicts any card the fetch now shows as not Done, such as one reopened in Jira. An empty ledger, on first run or with a pre-ledger `state.json`, means no lower bound: the first fetch seeds it with every Done card assigned to you.

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
- Rate limiting is retried inside `gh()` first (see `github.ts`). Whatever still reaches `errors.github` as a rate-limit failure — from any of the paths above — is replaced by the single line `GitHub throttled this refresh (rate limit) — showing last known data.`, since the fallbacks above have already kept the board usable; any non-throttle failure in the same refresh keeps its own message alongside it (#69).

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

`/api/*` paths that don't match `GET /api/data`, `GET /api/events`, `POST /api/refresh`, `POST /api/action`, `POST /api/write`, `GET /api/simon/runs`, or `GET /api/simon/runs/:id` (wrong method or unknown path) return `404` with `{ "error": "not found" }` instead of falling through to the SPA.

## Single-instance behavior

The server binds `127.0.0.1:<port>` (loopback only, not reachable from other hosts on the network) via `http.Server#listen`. If another instance is already bound to that port, `listen` fails with `EADDRINUSE`; the server logs `already running on port <port>` and exits with code 1, rather than probing a pid file (a pid file can false-negative after a crash, or false-positive if the pid was reused by an unrelated process). On successful bind, a `data/server.pid` file is written with `{ pid, port, startedAt }` for operator convenience (not used for the instance check itself), and removed on `SIGINT`/`SIGTERM`.

## CLI

`server/cli.ts` exposes `status`/`refresh`/`ack`/`move`/`unpin`/`transition`/`comment`/`pr-comment`/`serve`/`open` over this same API surface without a browser. Its core design is dual transport: it probes `GET /api/data` on `127.0.0.1:<port>` with a ~500ms timeout, and if that succeeds it drives every command through the HTTP endpoints documented above (so a running server's live in-memory state is the one read/mutated); if nothing answers, it operates directly on `data/state.json` via the same `loadState`/`saveState`/`refresh`/`applyAction` modules the server itself uses, so behavior is identical either way — that branch is chosen once per command in `server/ops.ts`, which both the CLI and the MCP server consume, and `ack`/`move` semantics in particular come from a single shared `applyAction` function (`server/actions.ts`) that both the HTTP handler and the CLI call, so the two transports can never drift. Which transport was used is always printed to stderr in human-readable mode. See the README's CLI section for usage examples.

## Demo mode

Set `"demo": true` in `config.json`, or run with `SIMON_DASH_DEMO=1` in the environment (`JIRA_DASH_DEMO=1` still works as a deprecated alias). In demo mode, `/api/refresh` skips Jira and GitHub entirely and imports canned data from `server/demo.ts` (`demoCards`/`demoPrs`), shaped to match what `jira.ts`'s `mapIssue` and `github.ts`'s `mapPr` (post-enrichment) would produce. That canned data runs through the same `buildSnapshot` pipeline as real data (classification, linking, `prLog` upsert, everything), so demo mode exercises the real logic end to end with no network calls and no credentials required. `errors.jira`/`errors.github` are always `null` in demo mode.

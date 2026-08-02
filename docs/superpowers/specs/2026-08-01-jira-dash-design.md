# jira-dash — Design Spec (2026-08-01)

Always-on browser dashboard for John's work Jira cards and their linked GitHub PRs. Modeled on the oss-autopilot dashboard (Preact SPA + local Node server), with its visual design copied directly.

## Goals

- One pinned browser tab showing every in-flight Jira card, its linked PR, and whether anything needs John's attention.
- Mostly read-only. The only writes are to the dashboard's own local state (bucket overrides, acknowledgements, tally). Jira and GitHub are never mutated.
- Refresh button + auto-refresh keep it current without Claude in the loop.
- Gamification: merged-PR tally, confetti + toast on new merges.

## Architecture

New repo `~/dev/jira-dash`:

```
server/   Node HTTP server, no framework, built-in fetch
web/      Preact 10 + Vite SPA (TypeScript)
data/     state.json (gitignored)
config.json (gitignored; config.example.json committed)
```

- Server serves the built SPA and a JSON API: `GET /api/data`, `POST /api/refresh`, `POST /api/action`.
- SPA never talks to Jira/GitHub directly; server does all fetching.
- Dev mode: Vite proxies `/api` to the server (same as oss-autopilot's vite.config).
- Server start: `npm start`, PID-file reuse (don't double-start), plus a launchd plist for always-on.

## Config (`config.json`, gitignored)

```json
{
  "jira": {
    "baseUrl": "https://<site>.atlassian.net",
    "email": "...",
    "apiToken": "...",
    "projectKey": "PROJ",
    "accountId": "..."
  },
  "github": {
    "token": "...",
    "org": "...",
    "repos": ["..."]
  },
  "port": 3010
}
```

All values placeholder now; John fills in on the work machine. GitHub token may fall back to `gh auth token` if unset.

## Data fetch (on refresh)

1. **Jira**: JQL search for cards assigned to `accountId` in `projectKey`, not Done. Per card: status, summary, description, comments (author + timestamp).
2. **GitHub**: for configured repos, open + recently-closed PRs authored by John. Per PR: state, merged flag, branch name, description, review comments + issue comments, latest CI check-run/status rollup.
3. **Linking** (either direction is sufficient):
   - Card key regex (`PROJ-\d+`) against PR branch name and PR title.
   - Jira card URL in PR description; PR URL in Jira card description.
4. Comments cache: keep fetched comments in state so the detail panel renders without refetch.

## Classification (server-side, recomputed each refresh)

Per linked card+PR, first match wins:

- **Needs Attention** when any of:
  - New comment on the PR (review or issue comment) by someone other than John since John's last-seen timestamp for that PR.
  - New comment/update on the Jira card by someone else since last-seen.
  - CI failing on the PR.
  - PR merged but Jira status is not "In Test" (card needs to be moved along).
- **In QA**: Jira status "In Test".
- **Waiting in Review**: PR open with review requested/pending and no attention triggers.
- **In Progress**: everything else in flight.
- **TODO section**: cards assigned to John in "To Do" status (no PR expected).

Unlinked edges: a card with no PR classifies on Jira status alone (comment triggers still apply). A PR with no matching card is ignored by the board but listed in a small "Unlinked PRs" footer so linking gaps are visible.

Manual bucket override (from `POST /api/action`) wins over computed bucket until the underlying facts change (new attention trigger re-flags it). "Acknowledge" sets last-seen to now, clearing comment-based attention. Same pattern as oss-autopilot's move/dismiss.

Jira status names ("To Do", "In Test") configurable in config with these defaults.

## State (`data/state.json`)

- Per card: last-seen timestamps (PR comments, Jira updates), manual bucket override, acknowledged flags.
- Merged tally: list of merged PR ids already celebrated + running count.
- Written atomically (tmp + rename). Single-user, single-process; no locking beyond that.

## UI

Visual design copied from the oss-autopilot dashboard (verified live at localhost:3000): its CSS, self-hosted @fontsource fonts, stat-card styling, row/section styling, dark/light theme with localStorage + pre-paint script.

Layout, top to bottom (mirrors oss-autopilot exactly):

- **Header**: centered logo + app title; below it a summary strip — left: "N in flight · N merged" (colored figures); right: "Updated Xm ago", theme toggle, 🎉 celebrate icon button, Refresh button.
- **Stats bar**: clickable stat cards with colored left borders — Needs Attention (red), In Progress (blue), Waiting in Review (amber), In QA (teal), TODO, Merged (purple). Click scrolls to section or routes to /merged. Animated count-up on load.
- **Filter bar**: status dropdown, repo dropdown, free-text search, "Showing X of Y cards" on the right.
- **Sections** (bucket lists, not side-by-side columns — oss-autopilot stacks them vertically): colored dot + section label + count chip. Needs Attention, In Progress, Waiting in Review, In QA. Row = colored status dot, monospace `PROJ-123` key, truncated summary, linked `repo#num`, status pill right-aligned (CI red / "N new comments" / merged), "Nd ago". Selected row gets a left accent border. Empty sections hidden.
- **Detail panel** on row click: sticky right-side panel, list shrinks left. Contents: card summary (title), status pill, `PROJ-123` + `repo#num` links out; labeled mini-sections in caps — JIRA STATUS, CI STATUS, REVIEW, NEW COMMENTS (recent comments from both Jira and GitHub with author + age), DAYS SINCE ACTIVITY, CREATED, UPDATED; bottom action buttons: **Acknowledge** and **Move to…** (bucket dropdown). Close ×.
- **TODO section** below buckets: plain list of To Do cards.
- **Recent Activity (Last 7 Days)** panel at the bottom: merged-PR events with pill + title + link + date. (Comment/status event groups deferred.)
- **/merged route**: Back button + sortable table (Card, PR, repo, date merged) like oss-autopilot's Merged PRs page.

## Gamification

- On refresh, merged PRs not yet in the celebrated list bump the tally, fire canvas-confetti (lazy-imported, `prefers-reduced-motion` respected) and a toast ("PROJ-123 merged 🎉"). Confetti style copied from oss-autopilot: ~full-screen stacked bursts from both edges over ~1s (verified live — fires on merged-count delta at load/refresh).
- Tally lives in state.json (server-side, unlike oss-autopilot's localStorage — survives browser resets).
- Manual Celebrate button replays confetti without touching the tally.

## Refresh & errors

- `POST /api/refresh`: fetch both sources, recompute, persist, return fresh payload.
- Auto-refresh on load + every 10 minutes while the tab is open.
- Per-source failure isolation: Jira down ≠ GitHub down. Show last-known data + banner naming the failed source. Never blank the board on error.

## Testing

- Vitest on the server logic: classification rules, link extraction (branch/title/description regexes), merged-tally dedupe.
- UI untested beyond compiling; it's a viewer.

## Out of scope (v1)

- Writing to Jira or GitHub (transitions, comments, replies).
- Charts (oss-autopilot's Monthly Activity / Top Repos chart.js panel — natural v1.1 once state accumulates history).
- Streaks, multi-user, auth on the local server.
- Claude integration (possible later: a skill that reads state.json and drafts replies).

# jira-dash

Local dashboard for Jira and GitHub PRs. Node server (port 3010 by default) serves a Preact SPA that tracks card status and PR activity across projects.

## Setup

### 1. Configure

Copy `config.example.json` to `config.json` and fill in:

- **Jira**: Get your API token at https://id.atlassian.com/manage-profile/security/api-tokens. Get your accountId by visiting `https://<baseUrl>/rest/api/3/myself` (e.g., `https://mysite.atlassian.net/rest/api/3/myself`) while logged in, then copy the `accountId` field, or ask a Claude session with the Atlassian MCP to look it up.
- **GitHub**: Create a token with `repo` read scope. Falls back to `GITHUB_TOKEN` env var if not provided in config.

### 2. Install

```bash
npm i
cd web && npm i
```

### 3. Run

```bash
./bin/start.sh
```

Starts the server on the configured port (default 3010). The script builds the web bundle if source files are stale; on first run it will take a moment.

### 4. launchd (optional)

To run jira-dash at startup on macOS:

```bash
cp launchd/com.johncosta.jira-dash.plist ~/Library/LaunchAgents/
```

Edit the plist to replace `REPLACE_WITH_REPO_PATH` with the absolute path to this repo, then:

```bash
launchctl load ~/Library/LaunchAgents/com.johncosta.jira-dash.plist
```

Logs go to `/tmp/jira-dash.log`. To unload: `launchctl unload ~/Library/LaunchAgents/com.johncosta.jira-dash.plist`.

## API

### GET /api/data

Returns current state snapshot: cards organized into buckets, TODO items, merged cards, recent activity, and any sync errors.

### POST /api/refresh

Fetch fresh data from Jira and GitHub, returning the updated snapshot.

### POST /api/action

Accept a card action as JSON:

- `type: 'ack'` - mark card as acknowledged. Clears attention flags, moves the card out of `needs_attention` (to its override bucket if one is set, otherwise a bucket derived from Jira status), and resets the "seen" horizon to the data horizon (the last snapshot's `updatedAt`, not wall-clock time). The override itself is **kept** — acking doesn't undo a prior manual move.
- `type: 'move', bucket: 'in_progress' | 'waiting_review' | 'in_qa'` - move card to a specific bucket and pin it there via an override. Also resets the "seen" horizon, so comments already accounted for don't immediately bounce the card back to `needs_attention` on the next refresh.
- `key` - Jira issue key (required for both).

All manual moves and acknowledgements are stored locally in `data/state.json`. Jira and GitHub are never written.

## Buckets

- **needs_attention**: Triggered by new PR comments from others since last-seen, new Jira card comments from others since last-seen, CI failing on an open PR, or a PR merged while the card is not in "In Test" or "Done" status. These "live" triggers (CI failing, merged-not-in-test) re-flag the card on the next refresh regardless of any override — only the comment-based triggers are silenced by acking/moving, since those reset the seen horizon. A manual move pins the card to that bucket until a fresh attention trigger fires.
- **in_qa**: Jira card status is "In Test".
- **waiting_review**: Open PR with review requests or active review comments.
- **in_progress**: Everything else (default).

## Local State

Manual moves and acknowledgements are stored in `data/state.json`. Server reads live Jira/GitHub state on each `/api/refresh` and merges with your local overrides.

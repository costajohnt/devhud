# jira-dash

Local dashboard for Jira and GitHub PRs. Node server (port 3010 by default) serves a Preact SPA that tracks card status and PR activity across projects.

See [docs/API.md](docs/API.md) for the full HTTP API reference and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the module map, data flow, and design decisions.

## Features

- **Buckets**: cards land in Needs Attention, In Progress, Waiting in Review, or In QA based on Jira status and linked PR state. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#classification-rules) for the exact rules.
- **Attention triggers**: a card surfaces in Needs Attention on CI failing, new PR comments, new Jira comments, or a merged PR whose card isn't yet In Test/Done.
- **Drag-and-drop**: drag a card between In Progress, Waiting in Review, and In QA to pin it there (an override), independent of what the classifier would otherwise pick.
- **Charts**: a Monthly Activity line chart (Opened/Merged/Closed) and a Top Repos stacked bar chart (Active/Merged/Closed), built from the full PR lifecycle log.
- **Activity groups**: a Recent Activity feed grouped by Merged, Closed, and Comments over the last 7 days.
- **Demo mode**: canned data through the real pipeline, no credentials or network calls required.
- **Celebration**: confetti and a toast the first time a PR is observed merged.

## Demo mode

Set `"demo": true` in `config.json` (or run with `JIRA_DASH_DEMO=1`) to feed canned cards and PRs through the real pipeline with no network calls. Useful for trying the UI before adding real credentials. Set it back to `false` once your tokens are in.

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

Full reference: [docs/API.md](docs/API.md). Summary: `GET /api/data` returns the last snapshot from memory, `POST /api/refresh` fetches fresh Jira/GitHub data (or demo data) and rebuilds it, `POST /api/action` applies an `ack` or `move` to one card. All manual moves and acknowledgements are stored locally in `data/state.json`; Jira and GitHub are never written to.

## Buckets

- **needs_attention**: Triggered by new PR comments from others since last-seen, new Jira card comments from others since last-seen, CI failing on an open PR, or a PR merged while the card is not in "In Test" or "Done" status. These "live" triggers (CI failing, merged-not-in-test) re-flag the card on the next refresh regardless of any override. Only the comment-based triggers are silenced by acking/moving, since those reset the seen horizon. A manual move pins the card to that bucket until a fresh attention trigger fires.
- **in_qa**: Jira card status is "In Test".
- **waiting_review**: Open PR with review requests or active review comments.
- **in_progress**: Everything else (default).

## Local State

Manual moves and acknowledgements are stored in `data/state.json`. Server reads live Jira/GitHub state on each `/api/refresh` and merges with your local overrides. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#statejson-anatomy) for the full shape.

// Write-back to Jira/GitHub: the only code in simon-dash that mutates
// external systems. Everything else (refresh, ack, move) is read-only or
// local-only. Plain fetch, same shape as jira.ts/github.ts — no deps,
// 30s timeouts, throws Error on a non-2xx response.
//
// Gated hard, on by nobody by default: config.writeEnabled must be true,
// and demo mode always refuses regardless of the flag (there's nothing
// real to write to). See checkWriteGate/performWrite below — every write
// path (POST /api/write, the CLI's transition/comment/pr-comment commands,
// the MCP write tools) goes through performWrite() so the gate and the
// post-write refresh can't drift between callers, mirroring applyAction's
// role for ack/move.
import { refresh } from './refresh.ts';
import { loadConfig } from './config.ts';
import { isPreTest, sameStatus } from './classify.ts';
import type { Card, Config, JiraConfig, GithubConfig, State, WriteGateResult, WriteResult } from './types.ts';

interface JiraTransition {
  id: string;
  to?: { name?: string };
}

// One paragraph node's content: a blank-line-free run of text, hardBreak
// nodes standing in for single \n line breaks within it. ADF has no notion
// of a literal newline inside a text node — every \n has to become either a
// paragraph boundary (blank line) or an explicit hardBreak node.
function adfParagraph(paragraphText: string) {
  const content: Array<{ type: string; text?: string }> = [];
  paragraphText.split('\n').forEach((line, i) => {
    if (i > 0) content.push({ type: 'hardBreak' });
    if (line) content.push({ type: 'text', text: line });
  });
  return { type: 'paragraph', content };
}

/**
 * Minimal ADF (Atlassian Document Format) doc from plain text: blank lines
 * (\n\n or more) become paragraph breaks, single \n becomes a hardBreak
 * within a paragraph. No formatting beyond that — this exists to make a
 * multi-line comment/description readable in Jira's UI, not to support
 * markdown or rich text.
 */
export function buildAdfDoc(text: string) {
  // Normalize Windows (\r\n) and old-Mac (\r) line endings to \n before
  // splitting, so a \r never ends up sitting inside an ADF text node (ADF
  // has no meaning for a literal \r any more than it does for \n).
  const normalized = text.replace(/\r\n?/g, '\n');
  const paragraphs = normalized.split(/\n{2,}/).map(adfParagraph);
  return { type: 'doc', version: 1, content: paragraphs.length ? paragraphs : [adfParagraph('')] };
}

// Case-insensitive match on transition.to.name (the workflow status a
// transition leads to, not the transition's own name/id — "targetStatusName"
// is what a caller thinks of as the destination status).
export function findTransition(transitions: JiraTransition[], targetStatusName: string | undefined): JiraTransition {
  const target = (targetStatusName ?? '').toLowerCase();
  const match = transitions.find(t => (t.to?.name ?? '').toLowerCase() === target);
  if (match) return match;
  const available = transitions.map(t => t.to?.name).filter(Boolean);
  throw new Error(
    `no transition to "${targetStatusName}" available from the card's current status; ` +
    `available: ${available.length ? available.join(', ') : '(none)'}`,
  );
}

function jiraAuth(cfg: JiraConfig): string {
  return 'Basic ' + Buffer.from(`${cfg.email}:${cfg.apiToken}`).toString('base64');
}

export async function transitionCard(cfg: JiraConfig, key: string, targetStatusName: string | undefined): Promise<{ transitionedTo: string }> {
  const auth = jiraAuth(cfg);
  // performWrite already validates key against KEY_RE before this is ever
  // called; encodeURIComponent here is belt-and-braces for any other caller.
  const url = new URL(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, cfg.baseUrl);
  const res = await fetch(url, { headers: { Authorization: auth, Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Jira ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json() as { transitions?: JiraTransition[] };
  const transition = findTransition(data.transitions ?? [], targetStatusName);
  const postRes = await fetch(url, {
    method: 'POST',
    headers: { Authorization: auth, Accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ transition: { id: transition.id } }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!postRes.ok) throw new Error(`Jira ${postRes.status}: ${(await postRes.text()).slice(0, 200)}`);
  return { transitionedTo: transition.to?.name ?? '' };
}

// Live status of one issue, read straight from Jira (not the last refresh).
// autoTransitionMergedCards calls this immediately before each transition so
// a card a human moved since the last tick is not moved again. statusCategory
// is mapped exactly as jira.ts's mapIssue does: anything other than
// 'new' | 'indeterminate' | 'done' becomes '' (name-only matching).
export async function getIssueStatus(cfg: JiraConfig, key: string): Promise<Pick<Card, 'status' | 'statusCategory'>> {
  const url = new URL(`/rest/api/3/issue/${encodeURIComponent(key)}`, cfg.baseUrl);
  url.searchParams.set('fields', 'status');
  const res = await fetch(url, { headers: { Authorization: jiraAuth(cfg), Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Jira ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json() as { fields?: { status?: { name?: string; statusCategory?: { key?: string } } } };
  const cat = data.fields?.status?.statusCategory?.key;
  return {
    status: data.fields?.status?.name ?? '',
    statusCategory: cat === 'new' || cat === 'indeterminate' || cat === 'done' ? cat : '',
  };
}

// Resolves with the new comment's id when Jira's response carries one (it
// does: POST /issue/{key}/comment returns the created comment), so
// performWrite can record it in State.postedCommentIds (L3). A response body
// that isn't JSON is not an error — the comment was created either way.
export async function commentCard(cfg: JiraConfig, key: string, body: string): Promise<{ commentId?: string }> {
  // See transitionCard: belt-and-braces encodeURIComponent, key is already
  // validated by performWrite before reaching this function.
  const url = new URL(`/rest/api/3/issue/${encodeURIComponent(key)}/comment`, cfg.baseUrl);
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: jiraAuth(cfg), Accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ body: buildAdfDoc(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Jira ${res.status}: ${(await res.text()).slice(0, 200)}`);
  let id: unknown;
  try { id = ((await res.json()) as { id?: unknown } | null)?.id; } catch { id = undefined; }
  return id != null && id !== '' ? { commentId: String(id) } : {};
}

// Bound on State.postedCommentIds: only recent comments can still sit in a
// card's fetched comment list, so older ids are dead weight.
export const POSTED_COMMENT_IDS_MAX = 200;

export function recordPostedComment(state: State, id: string): void {
  const ids = (state.postedCommentIds ?? []).filter(x => x !== id);
  ids.push(id);
  state.postedCommentIds = ids.slice(-POSTED_COMMENT_IDS_MAX);
}

export async function commentPr(cfg: GithubConfig, repo: string, number: number, body: string): Promise<Record<string, never>> {
  const res = await fetch(`https://api.github.com/repos/${repo}/issues/${number}/comments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/vnd.github+json', 'content-type': 'application/json' },
    body: JSON.stringify({ body }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return {};
}

// Demo mode has nothing real to write to, so it always refuses regardless
// of writeEnabled — but that's not an error state (nothing is misconfigured),
// so callers get a "stub success" shape ({ blocked: true, demo: true, ... })
// rather than one that reads as a failure. writeEnabled: false outside demo
// IS the user's explicit configuration blocking real writes, so that one
// stays a real refusal.
export function checkWriteGate(config: Pick<Config, 'demo' | 'writeEnabled'>): WriteGateResult {
  if (config.demo) {
    return { blocked: true, demo: true, message: 'demo mode: write-back is a no-op (nothing real to write to)' };
  }
  if (!config.writeEnabled) {
    return { blocked: true, demo: false, message: 'write-back disabled; set writeEnabled: true in config.json' };
  }
  return { blocked: false };
}

const WRITE_TYPES = ['transition', 'comment', 'pr_comment'];

// Jira issue key: one or more letters/digits/underscores starting with a
// letter, a dash, then digits (e.g. "PROJ-123"). Rejects anything that
// could smuggle a path segment (e.g. "PROJ-1/../x") into the URL built in
// transitionCard/commentCard below.
export const KEY_RE = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;
// "org/repo" — word chars, dots, and dashes only, exactly one slash.
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

export interface PerformWriteArgs {
  // Accepted but never read in the body below: every write path re-reads a
  // fresh `liveConfig` from disk (see the comment above that re-read) as the
  // sole source of truth for the gate, so a possibly-stale in-memory config
  // is deliberately not trusted here. Kept in the signature only so callers
  // (server/index.ts, cli.ts, mcp/handlers.ts) can pass their already-loaded
  // config without a special case, mirroring applyAction's calling
  // convention. Typed `unknown` rather than `Config` to reflect that
  // honestly instead of demanding callers (and tests) construct a full
  // Config just to satisfy a parameter nothing here looks at.
  config: unknown;
  state: State;
  type: string;
  key?: string;
  repo?: string;
  number?: number;
  body?: string;
  status?: string;
  refreshFn?: typeof refresh;
  configPath?: string;
  loadConfigFn?: typeof loadConfig;
}

// Shared entry point for every write path. `state` is mutated in place by
// the post-write refresh (same contract as applyAction) — callers persist
// it themselves. `refreshFn` defaults to the real refresh() and exists so
// tests can inject a throwing stub without reaching for module mocking.
// `configPath`/`loadConfigFn` exist for the same reason, feeding the fresh
// re-read below — see that comment for what/why.
// Returns:
//   - { ok: true, demo: true, message } — demo-mode stub, nothing written
//   - { ok: true, ...writebackResult } — real write succeeded, board refreshed
//   - { ok: true, ...writebackResult, refreshError } — write succeeded, but
//     the post-write refresh failed; still a success (the external write
//     went through), refreshError is a warning for the caller to surface,
//     not a reason to report the whole call as failed
//   - { error, status } — validation failure, gate refusal, or write failure
// `config` is deliberately absent from this destructure even though
// PerformWriteArgs still requires it — see that field's comment: the gate
// reads a fresh config from disk instead, and destructuring a binding this
// body never touches only invited the reader (and the linter) to assume
// otherwise.
export async function performWrite({
  state, type, key, repo, number, body, status,
  refreshFn = refresh, configPath, loadConfigFn = loadConfig,
}: PerformWriteArgs): Promise<WriteResult> {
  if (!WRITE_TYPES.includes(type)) {
    return { error: `unknown write type "${type}"`, status: 400 };
  }
  if (type === 'transition' && (!key || !status)) {
    return { error: 'transition requires key and status', status: 400 };
  }
  if (type === 'comment' && (!key || !body)) {
    return { error: 'comment requires key and body', status: 400 };
  }
  if (type === 'pr_comment' && (!repo || !number || !body)) {
    return { error: 'pr_comment requires repo, number, and body', status: 400 };
  }
  if ((type === 'transition' || type === 'comment') && !KEY_RE.test(key ?? '')) {
    return { error: `invalid Jira issue key "${key}"`, status: 400 };
  }
  if (type === 'pr_comment' && (!REPO_RE.test(repo ?? '') || !Number.isInteger(number))) {
    return { error: `invalid repo "${repo}" or PR number`, status: 400 };
  }

  // Re-read config from disk fresh on every write (not the possibly-
  // long-lived in-memory `config` a caller loaded once at process start),
  // so flipping writeEnabled (or demo) in config.json takes effect on the
  // very next write, with no server/CLI/MCP restart needed. loadConfig()
  // is cheap — one readFileSync + JSON.parse.
  //
  // Fails CLOSED, not open: if the re-read throws, this refuses the write
  // rather than falling back to the caller's possibly-stale in-memory
  // config. The whole point of re-reading is that config.json is the
  // current source of truth for "is writing allowed" — silently trusting
  // a stale in-memory config on read failure would mean deleting
  // config.json (or making it briefly unreadable) doesn't actually stop a
  // long-running process from continuing to write.
  let liveConfig: Config;
  try {
    liveConfig = loadConfigFn(configPath);
  } catch (e) {
    return { error: `config re-read failed (${(e as Error).message}); refusing write`, status: 403 };
  }

  const gate = checkWriteGate(liveConfig);
  if (gate.blocked) {
    if (gate.demo) return { ok: true, demo: true, message: gate.message ?? '' };
    return { error: gate.message ?? 'write-back disabled', status: 403 };
  }

  // Scope, not just shape: KEY_RE/REPO_RE stop URL smuggling, but the trust
  // question for the MCP surface is "is this a resource this dashboard
  // manages" — board text is attacker-adjacent (see mcp/handlers.ts's
  // UNTRUSTED_TEXT_NOTE), and without this a prompt-injected agent with
  // writeEnabled on could transition/comment ANY issue or repo the tokens
  // reach. Checked against the fresh liveConfig, same as the gate.
  if ((type === 'transition' || type === 'comment') && !key!.startsWith(`${liveConfig.jira.projectKey}-`)) {
    return { error: `key "${key}" is outside the configured project ${liveConfig.jira.projectKey}`, status: 403 };
  }
  // Same normalization rule as fetchPrs (github.ts): a repos[] entry may
  // already be fully qualified ("otherorg/svc"); only bare names get the
  // configured org prefixed.
  if (type === 'pr_comment' && !liveConfig.github.repos.some(r => (r.includes('/') ? r : `${liveConfig.github.org}/${r}`) === repo)) {
    return { error: `repo "${repo}" is not in the configured github.repos list`, status: 403 };
  }

  let result: { transitionedTo?: string };
  try {
    if (type === 'transition') result = await transitionCard(liveConfig.jira, key!, status);
    else if (type === 'comment') {
      // Record the id before the post-write refresh below so that refresh
      // already excludes it from the own-reply watermark (L3). Every write
      // path persists `state` afterwards: the server saves its in-memory
      // state, and CLI/MCP direct mode (ops.ts opWrite) saves the state it
      // loaded from disk. Best-effort: if that save is blocked the id is
      // lost and the comment counts as the user's own reply, as before.
      const { commentId } = await commentCard(liveConfig.jira, key!, body!);
      if (commentId) recordPostedComment(state, commentId);
      result = {};
    } else result = await commentPr(liveConfig.github, repo!, number!, body!);
  } catch (e) {
    return { error: (e as Error).message, status: 502 };
  }

  // Board reflects the write immediately instead of waiting for the next
  // poll. quiet: this call has no business writing to a CLI/MCP caller's
  // stdout on its own (and the old console.log monkeypatch here could
  // permanently noop logging under concurrent server writes).
  //
  // The write itself already succeeded by this point — a refresh failure
  // (Jira/GitHub hiccup, network blip) must not turn a successful write
  // into a reported failure. Caught separately and returned as a warning
  // field instead.
  let refreshError: string | undefined;
  try {
    await refreshFn({ config: liveConfig, state, quiet: true });
  } catch (e) {
    refreshError = (e as Error).message;
  }

  return refreshError ? { ok: true, ...result, refreshError } : { ok: true, ...result };
}

// attempted counts every candidate, including ones the live re-check skipped
// (neither succeeded nor failed: nothing was POSTed for those).
export interface AutoTransitionResult {
  attempted: number;
  succeeded: number;
  failed: number;
}

// Bound on State.autoTransitioned. One entry per (card, merged PR) ever
// auto-fired; oldest dropped first. 500 is years of merges for one developer.
const AUTO_TRANSITIONED_MAX = 500;

export const autoTransitionId = (key: string, pr: { repo: string; number: number }): string => `${key}@${pr.repo}#${pr.number}`;

// After each tick's refresh, move cards flagged merged_not_in_test to the In
// Test status. Called from the tick in index.ts before it broadcasts.
//
// Does NOT call performWrite() (which triggers a re-entrant refresh and
// doubles API spend). Calls transitionCard() directly; the tick re-runs the
// refresh itself when anything succeeded.
//
// Safety rules (H1), all on top of the config/write gates:
//  - The whole batch is skipped when the snapshot is degraded (errors.jira or
//    errors.github): on a Jira outage refresh falls back to lastCards, and a
//    stale "In Progress" may already be Done in Jira.
//  - Only cards whose current status is pre-test (isPreTest in classify.ts:
//    the configured In Progress/review names, never a To Do- or Done-category
//    status, never In Test or anything after it). The status is read from
//    state.lastCards (which carries statusCategory) when the card is there,
//    else from the snapshot item's jiraStatus name alone.
//  - Live re-check: immediately before each transition the issue's current
//    status is re-read from Jira (getIssueStatus). The snapshot status can be
//    up to refreshIntervalSeconds old, and transitionCard transitions from
//    the LIVE status, so a card a human moved since (to Done, back to To Do,
//    ...) must not be moved. It proceeds only if the live status is still
//    pre-test AND the same status the snapshot saw; otherwise it is skipped
//    and recorded in the ledger ({ ok: false, skipped: true, error }) so it
//    is not re-checked every tick. If the GET itself fails nothing is POSTed
//    and nothing is recorded, so the card is re-checked next tick.
//  - At most once per (card, merged PR): every attempt — success or failure —
//    is recorded in state.autoTransitioned and never retried, so a workflow
//    with no In Test transition logs one error, not one every tick. The
//    caller persists state.
//
// Per-card errors are logged and swallowed so one unavailable Jira transition
// does not abort the whole batch. transitionCardFn/getIssueStatusFn/now
// are injectable for tests.
export async function autoTransitionMergedCards({ state, configPath, loadConfigFn = loadConfig, transitionCardFn = transitionCard, getIssueStatusFn = getIssueStatus, now = () => new Date().toISOString() }: {
  state: State;
  configPath?: string;
  loadConfigFn?: typeof loadConfig;
  transitionCardFn?: typeof transitionCard;
  getIssueStatusFn?: typeof getIssueStatus;
  now?: () => string;
}): Promise<AutoTransitionResult> {
  const none = { attempted: 0, succeeded: 0, failed: 0 };
  // Same fail-closed rule as performWrite: the gate is read fresh from disk,
  // never from a long-lived in-memory config, so flipping writeEnabled or
  // autoTransitionMerged off stops the very next tick without a restart.
  let config: Config;
  try {
    config = loadConfigFn(configPath);
  } catch (e) {
    console.error(`auto-transition: config re-read failed (${(e as Error).message}); skipping`);
    return none;
  }
  if (!config.autoTransitionMerged) return none;

  const gate = checkWriteGate(config);
  if (gate.blocked) return none;

  const snapshot = state.snapshot;
  if (!snapshot) return none;
  if (snapshot.errors?.jira || snapshot.errors?.github) return none;

  const statuses = config.jira.statuses;
  const lastCards = new Map((state.lastCards ?? []).map(c => [c.key, c]));
  const ledger = (state.autoTransitioned ??= {});

  // Cards flagged merged_not_in_test are always routed to needs_attention
  // (it is a ROUTING_REASON in classify.ts). Items in attention have already
  // had acked reasons filtered out by classifyCard, but the spec asks for an
  // explicit ack check here too — belt-and-braces.
  const candidates = snapshot.buckets.needs_attention.filter(item => {
    if (!item.attention.includes('merged_not_in_test')) return false;
    // Same project scope check performWrite applies to transitions.
    if (!item.key.startsWith(`${config.jira.projectKey}-`)) return false;
    if ((state.cards[item.key]?.ackedReasons ?? []).includes('merged_not_in_test')) return false;
    if (!item.pr || item.pr.state !== 'merged') return false;
    if (ledger[autoTransitionId(item.key, item.pr)]) return false;
    const card = lastCards.get(item.key);
    return isPreTest(card ?? { status: item.jiraStatus }, statuses);
  });

  let succeeded = 0;
  let failed = 0;
  for (const item of candidates) {
    const id = autoTransitionId(item.key, item.pr!);
    const seen = lastCards.get(item.key)?.status ?? item.jiraStatus;
    let live: Pick<Card, 'status' | 'statusCategory'>;
    try {
      live = await getIssueStatusFn(config.jira, item.key);
    } catch (e) {
      // Transient (network/5xx): no POST, no ledger entry, retried next tick.
      console.error(`auto-transition: ${item.key} live status check failed — ${(e as Error).message} (will retry next tick)`);
      continue;
    }
    if (!sameStatus(live.status, seen) || !isPreTest(live, statuses)) {
      const reason = `status changed: ${seen} -> ${live.status || '(none)'}`;
      console.log(`auto-transition: ${item.key} skipped — ${reason}`);
      ledger[id] = { at: now(), ok: false, skipped: true, error: reason.slice(0, 200) };
      continue;
    }
    try {
      await transitionCardFn(config.jira, item.key, statuses.inTest);
      console.log(`auto-transition: ${item.key} -> ${statuses.inTest}`);
      ledger[id] = { at: now(), ok: true };
      succeeded++;
    } catch (e) {
      const message = (e as Error).message;
      console.error(`auto-transition: ${item.key} failed — ${message} (not retried for ${item.pr!.repo}#${item.pr!.number})`);
      ledger[id] = { at: now(), ok: false, error: message.slice(0, 200) };
      failed++;
    }
  }
  const ids = Object.keys(ledger);
  if (ids.length > AUTO_TRANSITIONED_MAX) {
    ids.sort((a, b) => ledger[a]!.at.localeCompare(ledger[b]!.at));
    for (const old of ids.slice(0, ids.length - AUTO_TRANSITIONED_MAX)) delete ledger[old];
  }
  return { attempted: candidates.length, succeeded, failed };
}

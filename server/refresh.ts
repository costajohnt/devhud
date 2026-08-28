import { cardState } from './state.ts';
import { linkPrsToCards, unlinked } from './link.ts';
import { classifyCard, isTodo, isDone, isCanceled, githubNewComment, jiraNewComment } from './classify.ts';
import { fetchJiraCards, doneWatermark } from './jira.ts';
import { fetchPrs, enrichPr } from './github.ts';
import type { Card, Pr, PrRef, State, Config, Snapshot, Bucket, Item, ActivityEntry, PrLogEntry, NewComment } from './types.ts';

const DAY = 86400000;

// How long a doneCelebrated entry is kept after its card stops appearing in
// fetches. Deliberately far wider than the Done watermark lag: the gap
// is the safety margin against a double celebration. See the prune in
// buildSnapshot.
export const CELEBRATION_RETENTION_DAYS = 90;

const prView = (p: Pr | null): PrRef | null => p && {
  repo: p.repo, number: p.number, url: p.url, branch: p.branch,
  state: p.state, ciStatus: p.ciStatus, reviewState: p.reviewState, isDraft: p.isDraft,
};

const newestFirst = (a: NewComment, b: NewComment) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '');

// Detail-panel activity: last 10 comments PER SOURCE, merged newest-first —
// per-source cap so a chatty PR review can't evict the entire Jira history
// from the panel (the detail view renders the sources as separate sections).
// Independent of newComments, which is seen-horizon-filtered and drives
// attention/badges.
const itemComments = (card: Card, pr: Pr | null): NewComment[] => {
  const fromPr: NewComment[] = (pr?.comments ?? []).map(githubNewComment);
  const fromJira: NewComment[] = (card.comments ?? []).map(jiraNewComment);
  const top10 = (cs: NewComment[]) => cs.sort(newestFirst).slice(0, 10);
  return [...top10(fromPr), ...top10(fromJira)].sort(newestFirst);
};

// Upsert every fetched PR into the lifecycle log, keyed by "org/repo#num".
// Runs on every refresh (real and demo) so prLog always reflects the latest
// known state of every PR ever seen. Never deletes entries — history only.
// closedAt only fires for closed-and-unmerged PRs; a merged PR gets mergedAt,
// not closedAt, mirroring oss-autopilot's Opened/Merged/Closed series.
function upsertPrLog(state: State, prs: Pr[]): void {
  for (const p of prs) {
    const id = `${p.repo}#${p.number}`;
    state.prLog[id] = {
      id,
      repo: p.repo,
      openedAt: p.createdAt ?? null,
      mergedAt: p.mergedAt ?? null,
      // closedAt from GitHub's own closed_at, not updatedAt: post-close
      // activity (a comment, a label) bumps updated_at and would silently
      // shift the PR between chart months on every refresh.
      closedAt: p.state === 'closed' ? (p.closedAt ?? p.updatedAt ?? null) : null,
    };
  }
}

export function buildSnapshot({ cards, prs, state, config, errors, degradedPrRepos }: {
  cards: Card[]; prs: Pr[]; state: State; config: Config; errors: { jira?: string; github?: string };
  // Which repos' PR data is degraded this refresh ('all' = the whole GitHub
  // fetch failed). Callers that don't track it (tests, direct use) default to
  // 'all' whenever errors.github is set — conservative, never prunes acks on
  // any error. refresh() passes the precise set so one permanently broken
  // repo in the config doesn't disable ack-pruning for every other repo's
  // cards forever.
  degradedPrRepos?: Set<string> | 'all';
}): Snapshot {
  const { statuses } = config.jira;
  const username = config.github.username;
  const ignoreAuthors = config.ignoreAuthors ?? [];
  state.prLog ??= {};
  state.doneCelebrated ??= [];
  upsertPrLog(state, prs);
  const linked = linkPrsToCards(cards, prs, config.jira.projectKey);

  const buckets: Record<Bucket, Item[]> = { needs_attention: [], in_progress: [], self_review: [], waiting_review: [], mergeable: [], qa_ready: [], in_qa: [] };
  const todo: Snapshot['todo'] = [];
  const doneCards: Snapshot['doneCards'] = [], newlyDone: string[] = [];
  // Cards seen this refresh that are NOT done (reopened, or canceled after
  // reaching Done). They must leave the lifetime ledger, or a card QA kicks
  // back stays counted as complete forever.
  const notDone = new Set<string>();

  // Both state-based attention reasons derive from PR data; when a card's PR
  // data is degraded this refresh, classify's ack-pruning must not treat
  // "reason missing from this refresh" as "reason cleared" — that would wipe
  // acks a healthy refresh would have kept.
  const degraded = degradedPrRepos ?? (errors.github ? 'all' : null);

  for (const card of cards) {
    // Canceled work is neither active nor complete — drop it from every bucket,
    // the Todo list, the Done page, and all counts.
    // Off-board routes (canceled/todo/done) never reach classifyCard, so its
    // ack-pruning can't run for them; forget acks here so a card that later
    // returns to the board (e.g. QA rejects a Done card back to In Progress)
    // re-triggers on a still-true reason instead of staying muted forever.
    if (isCanceled(card, statuses) || isTodo(card, statuses) || isDone(card, statuses)) {
      const cs = state.cards[card.key];
      if (cs?.ackedReasons) cs.ackedReasons = null;
    }
    if (!isDone(card, statuses)) notDone.add(card.key);
    if (isCanceled(card, statuses)) continue;
    const pr = linked.get(card.key) ?? null;
    if (isTodo(card, statuses) && !pr) { todo.push({ key: card.key, summary: card.summary, jiraUrl: card.url, createdAt: card.createdAt }); continue; }
    const cs = cardState(state, card.key);

    // A merged PR is supporting context, not completion: it rides along on the
    // active card via prView(pr) (the board's "Merged" pill, the detail panel),
    // and stays on the board so QA can still reject it. Completion follows the
    // Jira Done category below — a done card is celebrated once and drops off
    // the active board.
    if (isDone(card, statuses)) {
      // Only our own cards enter the permanent ledger. The JQL already filters
      // by assignee, but it didn't always: a fetch-layer bug wrote 25 other
      // people's cards here in a single refresh, and an append-only ledger has
      // no way to unlearn them. A fetch bug must not be able to write state
      // that outlives it. assigneeId is undefined for fixtures/demo cards,
      // which pass through as before.
      const mine = card.assigneeId === undefined || card.assigneeId === card.myAccountId;
      if (mine && !state.doneCelebrated.some(e => e.id === card.key)) {
        state.doneCelebrated.push({ id: card.key, at: card.updatedAt ?? new Date().toISOString() });
        newlyDone.push(card.key);
      }
      doneCards.push({ key: card.key, summary: card.summary, jiraStatus: card.status, jiraUrl: card.url, pr: prView(pr), doneAt: card.updatedAt });
      continue;
    }

    // A card with no PR under any degradation is treated as degraded too: we
    // can't tell whether its PR vanished or simply belongs to a failed repo.
    const prDegraded = degraded === 'all'
      || (degraded !== null && (pr ? degraded.has(pr.repo) : degraded.size > 0));
    const { bucket, attention, newComments } = classifyCard({ card, pr, cs, statuses, username, ignoreAuthors, prDegraded });
    const lastTs = [card.updatedAt, pr?.updatedAt].filter((x): x is string => Boolean(x)).sort().pop();
    buckets[bucket].push({
      key: card.key, summary: card.summary, jiraStatus: card.status, jiraUrl: card.url,
      fixVersions: card.fixVersions ?? [],
      bucket, attention, newComments, comments: itemComments(card, pr), pr: prView(pr),
      // Read after classifyCard, which auto-clears a stale override once the
      // card reaches In Test/Done — so this reflects the pin the board is
      // actually honoring, not one about to be dropped.
      pinned: cs.override !== null, pinnedAt: cs.overrideAt,
      createdAt: card.createdAt, updatedAt: card.updatedAt,
      daysSinceActivity: lastTs ? Math.max(0, Math.floor((Date.now() - Date.parse(lastTs)) / DAY)) : null,
    });
  }

  // Ledger retention. The ledger's only job is celebrating a card once, and an
  // entry can only do that job while its card can still turn up in a fetch —
  // Done cards are fetched only from the watermark forward. An entry that is
  // both absent from this refresh and older than the window is dead weight, so it
  // is dropped and the ledger stops growing without bound.
  //
  // This is also what gives an append-only structure a way to heal: a bad row
  // (the 25 cards a fetch-layer assignee bug wrote here) expires on its own
  // instead of needing a hand-run migration forever.
  //
  // Two properties this ordering depends on:
  //   - Entries for cards in *this* refresh are never dropped, whatever their
  //     age. Dropping one would re-celebrate the same card on the very next
  //     pass, every pass — confetti in a loop.
  //   - The window is far wider than the watermark lag, so an ordinary
  //     card is long gone from every fetch before its entry expires. Only a
  //     card resurrected after 90 silent days can celebrate twice, once.
  // An entry with a missing or unparseable timestamp is kept: never
  // re-celebrating is the safer failure, and the writer always stamps one.
  // Lifetime Done ledger, oss-autopilot's mergedPRs pattern: store every Done
  // card locally, fetch only what changed since the watermark, and merge by
  // key. This refresh's rows win (status/summary/PR can change after Done);
  // anything now non-Done is evicted. Result is an all-time list, so the
  // counter is the length of a complete list rather than of one fetch page.
  const ledgerByKey = new Map((state.doneLedger ?? []).map(d => [d.key, d]));
  for (const key of notDone) ledgerByKey.delete(key);
  for (const d of doneCards) ledgerByKey.set(d.key, d);
  const doneLedger = [...ledgerByKey.values()]
    .sort((a, b) => (b.doneAt ?? '').localeCompare(a.doneAt ?? ''));
  state.doneLedger = doneLedger;

  const fetchedDone = new Set(doneCards.map(d => d.key));
  const ledgerCutoff = Date.now() - CELEBRATION_RETENTION_DAYS * DAY;
  state.doneCelebrated = state.doneCelebrated.filter(e => {
    if (fetchedDone.has(e.id)) return true;
    const at = e.at ? Date.parse(e.at) : NaN;
    return Number.isNaN(at) || at > ledgerCutoff;
  });

  const weekAgo = Date.now() - 7 * DAY;

  // Merged/closed PRs from the last 7 days still surface in Recent Activity as
  // supporting context. They're derived straight from the fetched PRs — no
  // dedicated payload field — since the board no longer has Merged/Closed pages.
  const mergedActivity: ActivityEntry[] = prs
    .filter(p => p.mergedAt && Date.parse(p.mergedAt) > weekAgo)
    .map(p => ({ type: 'merged', label: p.title || `${p.repo}#${p.number}`, url: p.url, date: p.mergedAt! }));
  // closedAt (GitHub's closed_at) preferred over updatedAt: post-close
  // activity bumps updated_at and would resurface/re-date old closures.
  const closedActivity: ActivityEntry[] = prs
    .filter(p => p.state === 'closed' && !p.mergedAt)
    .map(p => ({ p, date: p.closedAt ?? p.updatedAt }))
    .filter(({ date }) => date && Date.parse(date) > weekAgo)
    .map(({ p, date }) => ({ type: 'closed' as const, label: p.title || `${p.repo}#${p.number}`, url: p.url, date }));
  // Comments surface from the board items just built above: each item's
  // newComments already carries source/author/createdAt, so no re-scan of
  // cards/prs is needed. url follows the comment's source (PR vs Jira card).
  const commentActivity: ActivityEntry[] = [];
  for (const bucketItems of Object.values(buckets)) {
    for (const item of bucketItems) {
      for (const c of item.newComments) {
        if (!c.createdAt || Date.parse(c.createdAt) <= weekAgo) continue;
        commentActivity.push({
          type: 'comment',
          label: `${item.key}: comment from ${c.author}`,
          url: c.source === 'github' ? (item.pr?.url ?? item.jiraUrl) : item.jiraUrl,
          date: c.createdAt,
        });
      }
    }
  }
  const recentActivity = [...mergedActivity, ...closedActivity, ...commentActivity]
    .sort((a, b) => b.date.localeCompare(a.date));

  return {
    updatedAt: new Date().toISOString(),
    errors: { jira: errors.jira ?? null, github: errors.github ?? null },
    buckets, todo,
    unlinkedPrs: unlinked(prs, linked).filter(p => p.state === 'open')
      .map(p => ({ repo: p.repo, number: p.number, url: p.url, title: p.title, state: p.state })),
    // Done page and counter both come from the lifetime ledger, so they agree
    // by construction. Deriving the count from a single refresh made it shrink
    // as cards aged out of the fetch window; deriving it from the old
    // append-only doneCelebrated ledger let it drift above the rows (a header
    // reading 32 over a 4-row table). doneCelebrated stays scoped to the one
    // job it is good for: celebrate-once dedup via newlyDone.
    doneCards: doneLedger, doneTotal: doneLedger.length, newlyDone, recentActivity,
    prLog: Object.values(state.prLog) as PrLogEntry[],
  };
}

// Module-level, single-process monotonic sequence for concurrent refreshes
// (two browser tabs, or the CLI plus the web UI's own poll timer). Neither
// fetch nor buildSnapshot has any ordering guarantee — the slower call can
// easily be the one with fresher upstream data, so "last buildSnapshot to
// finish wins" would let a call that started earlier (and fetched newer
// data) get clobbered by one that started later but happened to finish
// first with staler data. Each refresh() call grabs the next number at
// entry; the actual state.snapshot/lastRefreshAt write near the end of the
// function only happens if no later-sequenced call has already completed
// one. Card-state and celebration mutations inside buildSnapshot are NOT
// gated by this — they run unconditionally on every call regardless of
// ordering, verified safe: a merge is celebrated once no matter which
// refresh notices it first, and cardState/override mutations are
// idempotent writes keyed by card key, not append-only history. One
// exception to that idempotence claim: ackedReasons pruning in
// classifyCard is data-driven and destructive, so a losing (staler)
// refresh can prune an ack the winning refresh's data would have kept.
// The prDegraded guard covers the error paths; a healthy-but-stale race
// window remains and is accepted — worst case is one extra
// needs_attention round-trip.
let refreshSeq = 0;
let lastCompletedRefreshSeq = 0;

// On a source failure, reuse that source's last-known-good data instead of
// blanking the board — a transient Jira/GitHub outage shouldn't wipe out
// everything the user was tracking.
// `quiet` suppresses the operational log line — for callers whose stdout is
// a protocol channel (MCP) or user-facing output (CLI, writeback's
// post-write refresh), which previously monkeypatched the global
// console.log around the call; under concurrent server requests two
// interleaved patches could permanently noop console.log for the process.
export async function refresh({ config, state, quiet }: { config: Config; state: State; quiet?: boolean }): Promise<Snapshot> {
  const seq = ++refreshSeq;
  const errors: { jira?: string; github?: string } = {};
  // Repos whose PR data is degraded this refresh (fetch or enrichment
  // failure — even with a last-known-good fallback the data is stale);
  // prFetchFailed marks the everything-failed case. Feeds ack-pruning: see
  // buildSnapshot's degradedPrRepos.
  const degradedPrRepos = new Set<string>();
  let prFetchFailed = false;
  let cards: Card[], prs: Pr[];
  if (config.demo) {
    // Demo mode: canned data through the real pipeline, no network.
    const { demoCards, demoPrs } = await import('./demo.ts');
    cards = demoCards(config.jira);
    prs = demoPrs(config.github);
    const payload = buildSnapshot({ cards, prs, state, config, errors });
    if (seq > lastCompletedRefreshSeq) {
      lastCompletedRefreshSeq = seq;
      state.snapshot = payload;
      state.lastRefreshAt = payload.updatedAt;
    }
    if (!quiet) console.log(`refresh (demo): ${cards.length} cards, ${prs.length} prs`);
    return state.snapshot ?? payload;
  }
  let jiraOk = false, githubOk = false;
  try {
    cards = await fetchJiraCards(config.jira, doneWatermark(state.doneLedger ?? []));
    jiraOk = true;
  } catch (e) {
    errors.jira = (e as Error).message;
    cards = state.lastCards ?? [];
  }
  try {
    const gh = await fetchPrs(config.github);
    prs = gh.prs;
    // fetchPrs isolates per-repo failures into "org/repo: msg" strings so one
    // bad repo doesn't blank the others; splice that repo's last-known-good
    // PRs back in from state.lastPrs so it doesn't vanish from the board.
    if (gh.errors.length) {
      errors.github = gh.errors.join('; ');
      for (const err of gh.errors) {
        const failedRepo = err.match(/^([^:]+):/)?.[1];
        if (failedRepo) {
          degradedPrRepos.add(failedRepo);
          prs.push(...(state.lastPrs ?? []).filter(p => p.repo === failedRepo));
        }
      }
    }
    const linked = linkPrsToCards(cards, prs, config.jira.projectKey);
    const toEnrich = [...new Set(linked.values())];
    // Enrich in small batches to avoid GitHub's secondary (concurrency-based)
    // rate limit. Each enrichPr fires 3-4 parallel API calls, so a batch of 3
    // means ~12 concurrent requests, well under the threshold.
    const BATCH = 3;
    const results: PromiseSettledResult<Pr>[] = [];
    for (let i = 0; i < toEnrich.length; i += BATCH) {
      const batch = toEnrich.slice(i, i + BATCH);
      results.push(...await Promise.allSettled(batch.map(p => enrichPr(p, config.github))));
    }
    const failed = results.filter(r => r.status === 'rejected');
    if (failed.length) errors.github = [errors.github, ...failed.map(f => (f as PromiseRejectedResult).reason?.message)].filter(Boolean).join('; ');
    // Replace any PR whose enrichment rejected with its last-known-good
    // counterpart (matched by repo+number) so a transient detail-fetch
    // failure doesn't strip CI/review/comment data the board already had.
    results.forEach((r, i) => {
      if (r.status !== 'rejected') return;
      const pr = toEnrich[i]!;
      degradedPrRepos.add(pr.repo);
      const fallback = (state.lastPrs ?? []).find(lp => lp.repo === pr.repo && lp.number === pr.number);
      if (!fallback) return;
      const idx = prs.indexOf(pr);
      if (idx >= 0) prs[idx] = fallback;
    });
    githubOk = true;
  } catch (e) {
    errors.github = [errors.github, (e as Error).message].filter(Boolean).join('; ');
    prs = state.lastPrs ?? [];
    prFetchFailed = true;
  }
  const payload = buildSnapshot({ cards, prs, state, config, errors, degradedPrRepos: prFetchFailed ? 'all' : degradedPrRepos });
  if (seq > lastCompletedRefreshSeq) {
    lastCompletedRefreshSeq = seq;
    state.snapshot = payload;
    state.lastRefreshAt = payload.updatedAt;
    // The last-known-good caches live inside the same gate as the snapshot:
    // they're the outage fallback, and an unguarded write let a slower stale
    // refresh overwrite a fresher call's caches after the fact.
    if (jiraOk) state.lastCards = cards;
    if (githubOk) state.lastPrs = prs;
  }
  if (!quiet) console.log(`refresh: ${cards.length} cards, ${prs.length} prs — jira ${errors.jira ? `error: ${errors.jira}` : 'ok'}, github ${errors.github ? `error: ${errors.github}` : 'ok'}`);
  // state.snapshot, not payload: if this call lost the seq race, the winner's
  // snapshot is fresher — returning our own would hand callers (and the SSE
  // broadcast) stale data that state itself already rejected.
  return state.snapshot ?? payload;
}

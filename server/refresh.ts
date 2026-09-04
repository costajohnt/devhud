import { cardState } from './state.ts';
import { linkPrsToCards, unlinked } from './link.ts';
import { classifyCard, isTodo, isDone, isCanceled, isBlocked, githubNewComment, jiraNewComment } from './classify.ts';
import { fetchJiraCards, doneWatermark } from './jira.ts';
import { fetchPrs, enrichPr, isThrottleMessage, resetGithubStats, formatGithubStats } from './github.ts';
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
  const blocked: Snapshot['blocked'] = [];
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
    // Off-board routes (canceled/todo/blocked/done) never reach classifyCard, so its
    // ack-pruning can't run for them; forget acks here so a card that later
    // returns to the board (e.g. QA rejects a Done card back to In Progress)
    // re-triggers on a still-true reason instead of staying muted forever.
    if (isCanceled(card, statuses) || isTodo(card, statuses) || isBlocked(card, statuses) || isDone(card, statuses)) {
      const cs = state.cards[card.key];
      if (cs?.ackedReasons) cs.ackedReasons = null;
    }
    if (!isDone(card, statuses)) notDone.add(card.key);
    if (isCanceled(card, statuses)) continue;
    const pr = linked.get(card.key) ?? null;
    // Blocked is name-only and more specific than the To Do category, so it
    // wins if a project files the status under 'new'. Unlike todo, a linked
    // PR does not keep the card on the board: Jira saying blocked is the
    // lifecycle statement.
    if (isBlocked(card, statuses)) { blocked.push({ key: card.key, summary: card.summary, jiraUrl: card.url, createdAt: card.createdAt }); continue; }
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
    buckets, todo, blocked,
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

// Concurrent refreshes (two browser tabs, the CLI, a writeback's post-write
// refresh, the server's own timer) are serialized per State, and every caller
// that arrives while one is in flight shares a single follow-up (#72). That
// bounds the API spend to at most one extra sweep however many callers pile
// up, and it keeps the ordering guarantee the old sequence gate provided:
// snapshot and last-known-good caches are always written by the refresh
// that fetched most recently. A follow-up rather than a join, because a
// writeback's post-write refresh needs data fetched *after* its write, and
// the in-flight sweep may have read Jira before it.
const running = new WeakMap<State, Promise<Snapshot>>();
const queued = new WeakMap<State, Promise<Snapshot>>();

export function refresh(opts: { config: Config; state: State; quiet?: boolean }): Promise<Snapshot> {
  const { state } = opts;
  const current = running.get(state);
  if (!current) {
    const p = runRefresh(opts).finally(() => { if (running.get(state) === p) running.delete(state); });
    running.set(state, p);
    return p;
  }
  const follow = queued.get(state);
  if (follow) return follow;
  // The follow-up starts once the current sweep settles (success or failure
  // alike: a failed refresh already fell back to last-known-good data).
  const p = current.then(() => undefined, () => undefined).then(() => {
    queued.delete(state);
    return refresh(opts);
  });
  queued.set(state, p);
  return p;
}

// On a source failure, reuse that source's last-known-good data instead of
// blanking the board — a transient Jira/GitHub outage shouldn't wipe out
// everything the user was tracking.
// `quiet` suppresses the operational log line — for callers whose stdout is
// a protocol channel (MCP) or user-facing output (CLI, writeback's
// post-write refresh), which previously monkeypatched the global
// console.log around the call; under concurrent server requests two
// interleaved patches could permanently noop console.log for the process.
async function runRefresh({ config, state, quiet }: { config: Config; state: State; quiet?: boolean }): Promise<Snapshot> {
  const errors: { jira?: string; github?: string } = {};
  // Repos whose PR data is degraded this refresh (fetch or enrichment
  // failure — even with a last-known-good fallback the data is stale);
  // prFetchFailed marks the everything-failed case. Feeds ack-pruning: see
  // buildSnapshot's degradedPrRepos.
  const degradedPrRepos = new Set<string>();
  let prFetchFailed = false;
  let reused = 0;
  let cards: Card[], prs: Pr[];
  if (config.demo) {
    // Demo mode: canned data through the real pipeline, no network.
    const { demoCards, demoPrs } = await import('./demo.ts');
    cards = demoCards(config.jira);
    prs = demoPrs(config.github);
    const payload = buildSnapshot({ cards, prs, state, config, errors });
    state.snapshot = payload;
    state.lastRefreshAt = payload.updatedAt;
    if (!quiet) console.log(`refresh (demo): ${cards.length} cards, ${prs.length} prs`);
    return payload;
  }
  resetGithubStats();
  let jiraOk = false, githubOk = false;
  try {
    cards = await fetchJiraCards(config.jira, doneWatermark(state.doneLedger ?? []));
    jiraOk = true;
  } catch (e) {
    errors.jira = (e as Error).message;
    cards = state.lastCards ?? [];
  }
  // Collected rather than concatenated as we go, so the compose step below can
  // tell a throttle apart from a real failure and keep both legible (#69).
  const githubErrors: string[] = [];
  try {
    const gh = await fetchPrs(config.github);
    prs = gh.prs;
    // fetchPrs isolates per-repo failures into "org/repo: msg" strings so one
    // bad repo doesn't blank the others; splice that repo's last-known-good
    // PRs back in from state.lastPrs so it doesn't vanish from the board.
    if (gh.errors.length) {
      githubErrors.push(...gh.errors);
      for (const err of gh.errors) {
        const failedRepo = err.match(/^([^:]+):/)?.[1];
        if (failedRepo) {
          degradedPrRepos.add(failedRepo);
          prs.push(...(state.lastPrs ?? []).filter(p => p.repo === failedRepo));
        }
      }
    }
    const linked = linkPrsToCards(cards, prs, config.jira.projectKey);
    // Enrich only linked PRs that changed since the last refresh. GitHub bumps
    // a PR's updated_at for every comment, review, review request, push and
    // label, so an unchanged updatedAt means last refresh's comments and
    // review state still hold; CI arrives with discovery (mapPr) and is
    // already fresh on the new object. This is what makes a quiet refresh
    // cost one request per repo instead of three per linked PR (#72).
    const previous = new Map((state.lastPrs ?? []).map(p => [`${p.repo}#${p.number}`, p]));
    const toEnrich: Pr[] = [];
    for (const p of new Set(linked.values())) {
      const last = previous.get(`${p.repo}#${p.number}`);
      if (!last?.enriched || last.updatedAt !== p.updatedAt) { toEnrich.push(p); continue; }
      p.comments = last.comments;
      if (p.reviewState !== 'review_required') p.reviewState = last.reviewState;
      p.enriched = true;
      reused++;
    }
    // Enrich in small batches to avoid GitHub's secondary rate limit. Each
    // enrichPr fires 3 parallel API calls, so a batch of 3 means ~9
    // concurrent requests, well under the concurrency threshold — but that
    // limit is rate-shaped too, and back-to-back batches sustain a request
    // *rate* that trips it on a large enrich set (#69). The pause between
    // batches shapes the whole sweep rather than just its width; gh() backs
    // off and retries if one gets through anyway.
    const BATCH = 3;
    const BATCH_PAUSE_MS = 200;
    const results: PromiseSettledResult<Pr>[] = [];
    for (let i = 0; i < toEnrich.length; i += BATCH) {
      if (i > 0) await new Promise(r => setTimeout(r, BATCH_PAUSE_MS));
      const batch = toEnrich.slice(i, i + BATCH);
      results.push(...await Promise.allSettled(batch.map(p => enrichPr(p, config.github))));
    }
    const failed = results.filter(r => r.status === 'rejected');
    if (failed.length) githubErrors.push(...failed.map(f => (f as PromiseRejectedResult).reason?.message).filter((m): m is string => !!m));
    // Replace any PR whose enrichment rejected with its last-known-good
    // counterpart (matched by repo+number) so a transient detail-fetch
    // failure doesn't strip review/comment data the board already had. The
    // counterpart keeps its older updatedAt, so the next refresh re-enriches
    // it rather than reusing it.
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
    githubErrors.push((e as Error).message);
    prs = state.lastPrs ?? [];
    prFetchFailed = true;
  }
  // A throttle that survives gh()'s retries is the least alarming failure the
  // banner can carry: the last-known-good splices above keep the board usable
  // and the next tick usually clears it, so every throttled path collapses into
  // one calm sentence instead of pasting a URL and a JSON blob at the user
  // (#69). Any non-throttle failure keeps its own message — that one still
  // needs reading.
  const throttled = githubErrors.filter(isThrottleMessage);
  const realFailures = githubErrors.filter(m => !isThrottleMessage(m));
  if (throttled.length) realFailures.unshift('GitHub throttled this refresh (rate limit) — showing last known data.');
  if (realFailures.length) errors.github = realFailures.join('; ');
  const payload = buildSnapshot({ cards, prs, state, config, errors, degradedPrRepos: prFetchFailed ? 'all' : degradedPrRepos });
  state.snapshot = payload;
  state.lastRefreshAt = payload.updatedAt;
  // The last-known-good caches are the outage fallback; only a source that
  // answered this refresh may overwrite its cache.
  if (jiraOk) state.lastCards = cards;
  if (githubOk) state.lastPrs = prs;
  if (!quiet) {
    console.log(`refresh: ${cards.length} cards, ${prs.length} prs — jira ${errors.jira ? `error: ${errors.jira}` : 'ok'}, github ${errors.github ? `error: ${errors.github}` : 'ok'}`);
    console.log(`refresh: github ${formatGithubStats()}, ${reused} linked PRs reused unchanged`);
  }
  return payload;
}

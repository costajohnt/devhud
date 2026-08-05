import { cardState } from './state.ts';
import { linkPrsToCards, unlinked } from './link.ts';
import { classifyCard, isTodo, isDone, isCanceled } from './classify.ts';
import { fetchJiraCards } from './jira.ts';
import { fetchPrs, enrichPr } from './github.ts';
import type { Card, Pr, PrRef, State, Config, Snapshot, Bucket, Item, ActivityEntry, PrLogEntry, NewComment } from './types.ts';

const DAY = 86400000;

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
  const fromPr: NewComment[] = (pr?.comments ?? []).map(c => ({ source: 'github', author: c.author, body: c.body?.slice(0, 300) ?? '', createdAt: c.createdAt ?? null }));
  const fromJira: NewComment[] = (card.comments ?? []).map(c => ({ source: 'jira', author: c.author || c.authorId || '', body: c.body?.slice(0, 300) ?? '', createdAt: c.createdAt }));
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
      closedAt: p.state === 'closed' ? (p.updatedAt ?? null) : null,
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

  const buckets: Record<Bucket, Item[]> = { needs_attention: [], in_progress: [], self_review: [], waiting_review: [], in_qa: [] };
  const todo: Snapshot['todo'] = [];
  const doneCards: Snapshot['doneCards'] = [], newlyDone: string[] = [];

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
      if (!state.doneCelebrated.some(e => e.id === card.key)) {
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
      createdAt: card.createdAt, updatedAt: card.updatedAt,
      daysSinceActivity: lastTs ? Math.max(0, Math.floor((Date.now() - Date.parse(lastTs)) / DAY)) : null,
    });
  }

  const weekAgo = Date.now() - 7 * DAY;

  // Merged/closed PRs from the last 7 days still surface in Recent Activity as
  // supporting context. They're derived straight from the fetched PRs — no
  // dedicated payload field — since the board no longer has Merged/Closed pages.
  const mergedActivity: ActivityEntry[] = prs
    .filter(p => p.mergedAt && Date.parse(p.mergedAt) > weekAgo)
    .map(p => ({ type: 'merged', label: p.title || `${p.repo}#${p.number}`, url: p.url, date: p.mergedAt! }));
  const closedActivity: ActivityEntry[] = prs
    .filter(p => p.state === 'closed' && !p.mergedAt && p.updatedAt && Date.parse(p.updatedAt) > weekAgo)
    .map(p => ({ type: 'closed', label: p.title || `${p.repo}#${p.number}`, url: p.url, date: p.updatedAt }));
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
    // The Done counter is the size of the Done list it sits above: both are
    // this refresh's Done-category cards. A running all-time counter drifted
    // from the list it labelled (celebrated cards that later aged out of the
    // JQL window, or stopped matching it, stayed in the count forever).
    doneCards, doneTotal: doneCards.length, newlyDone, recentActivity,
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
export async function refresh({ config, state }: { config: Config; state: State }): Promise<Snapshot> {
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
    console.log(`refresh (demo): ${cards.length} cards, ${prs.length} prs`);
    return payload;
  }
  try {
    cards = await fetchJiraCards(config.jira);
    state.lastCards = cards;
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
    const results = await Promise.allSettled(toEnrich.map(p => enrichPr(p, config.github)));
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
    state.lastPrs = prs;
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
  }
  console.log(`refresh: ${cards.length} cards, ${prs.length} prs — jira ${errors.jira ? `error: ${errors.jira}` : 'ok'}, github ${errors.github ? `error: ${errors.github}` : 'ok'}`);
  return payload;
}

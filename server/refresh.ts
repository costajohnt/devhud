import { cardState } from './state.ts';
import { linkPrsToCards, unlinked } from './link.ts';
import { classifyCard, isTodo, isDone } from './classify.ts';
import { fetchJiraCards } from './jira.ts';
import { fetchPrs, enrichPr } from './github.ts';
import type { Card, Pr, PrRef, State, Config, Snapshot, Bucket, Item, ActivityEntry, ClosedPr, PrLogEntry, NewComment } from './types.ts';

const DAY = 86400000;

const prView = (p: Pr | null): PrRef | null => p && {
  repo: p.repo, number: p.number, url: p.url, branch: p.branch,
  state: p.state, ciStatus: p.ciStatus, reviewState: p.reviewState,
};

// Full comment history for the detail panel's "Comments" section: last 10
// comments merged from both sources, newest first, regardless of whether
// classifyCard already flagged them as "new". Independent of newComments,
// which is seen-horizon-filtered and drives attention/badges.
const itemComments = (card: Card, pr: Pr | null): NewComment[] => {
  const fromPr: NewComment[] = (pr?.comments ?? []).map(c => ({ source: 'github', author: c.author, body: c.body?.slice(0, 300) ?? '', createdAt: c.createdAt ?? null }));
  const fromJira: NewComment[] = (card.comments ?? []).map(c => ({ source: 'jira', author: c.author || c.authorId || '', body: c.body?.slice(0, 300) ?? '', createdAt: c.createdAt }));
  return [...fromPr, ...fromJira]
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
    .slice(0, 10);
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

export function buildSnapshot({ cards, prs, state, config, errors }: {
  cards: Card[]; prs: Pr[]; state: State; config: Config; errors: { jira?: string; github?: string };
}): Snapshot {
  const { statuses } = config.jira;
  const username = config.github.username;
  state.prLog ??= {};
  upsertPrLog(state, prs);
  const linked = linkPrsToCards(cards, prs, config.jira.projectKey);

  const buckets: Record<Bucket, Item[]> = { needs_attention: [], in_progress: [], waiting_review: [], in_qa: [] };
  const todo: Snapshot['todo'] = [], mergedCards: Snapshot['mergedCards'] = [], newlyMerged: string[] = [];

  for (const card of cards) {
    if (isTodo(card, statuses)) { todo.push({ key: card.key, summary: card.summary, jiraUrl: card.url, createdAt: card.createdAt }); continue; }
    const pr = linked.get(card.key) ?? null;
    const cs = cardState(state, card.key);

    if (pr?.state === 'merged') {
      const id = `${pr.repo}#${pr.number}`;
      if (!state.celebrated.some(e => e.id === id)) {
        state.celebrated.push({ id, at: pr.mergedAt ?? new Date().toISOString() });
        state.mergedTotal += 1;
        newlyMerged.push(card.key);
      }
      // The Merged page is driven by the PR's merge event, not the card's Jira
      // status. In this workflow a merge moves the card to In QA / In Test, and
      // Done only comes later once QA approves (many cards never get there), so
      // gating inclusion on Done left the page almost always empty. Jira status
      // rides along as a displayed column, not as the inclusion filter.
      mergedCards.push({ key: card.key, summary: card.summary, jiraStatus: card.status, jiraUrl: card.url, pr: prView(pr), mergedAt: pr.mergedAt });
      // Done cards drop off the board; a merged-but-not-Done card (In QA / In
      // Test) stays on the board below so QA can still reject it.
      if (isDone(card, statuses)) continue;
    }
    if (isDone(card, statuses)) continue;

    const { bucket, attention, newComments } = classifyCard({ card, pr, cs, statuses, username });
    const lastTs = [card.updatedAt, pr?.updatedAt].filter((x): x is string => Boolean(x)).sort().pop();
    buckets[bucket].push({
      key: card.key, summary: card.summary, jiraStatus: card.status, jiraUrl: card.url,
      bucket, attention, newComments, comments: itemComments(card, pr), pr: prView(pr),
      createdAt: card.createdAt, updatedAt: card.updatedAt,
      daysSinceActivity: lastTs ? Math.max(0, Math.floor((Date.now() - Date.parse(lastTs)) / DAY)) : null,
    });
  }

  const weekAgo = Date.now() - 7 * DAY;

  const closedPrs: ClosedPr[] = prs
    .filter(p => p.state === 'closed' && !p.mergedAt)
    .map(p => ({ repo: p.repo, number: p.number, url: p.url, title: p.title, closedAt: p.updatedAt }))
    .sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''));

  const mergedActivity: ActivityEntry[] = prs
    .filter(p => p.mergedAt && Date.parse(p.mergedAt) > weekAgo)
    .map(p => ({ type: 'merged', label: p.title || `${p.repo}#${p.number}`, url: p.url, date: p.mergedAt! }));
  const closedActivity: ActivityEntry[] = closedPrs
    .filter(p => p.closedAt && Date.parse(p.closedAt) > weekAgo)
    .map(p => ({ type: 'closed', label: p.title || `${p.repo}#${p.number}`, url: p.url, date: p.closedAt }));
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
    mergedCards, mergedTotal: state.mergedTotal, newlyMerged, recentActivity,
    closedPrs,
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
// idempotent writes keyed by card key, not append-only history.
let refreshSeq = 0;
let lastCompletedRefreshSeq = 0;

// On a source failure, reuse that source's last-known-good data instead of
// blanking the board — a transient Jira/GitHub outage shouldn't wipe out
// everything the user was tracking.
export async function refresh({ config, state }: { config: Config; state: State }): Promise<Snapshot> {
  const seq = ++refreshSeq;
  const errors: { jira?: string; github?: string } = {};
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
        if (failedRepo) prs.push(...(state.lastPrs ?? []).filter(p => p.repo === failedRepo));
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
      const fallback = (state.lastPrs ?? []).find(lp => lp.repo === pr.repo && lp.number === pr.number);
      if (!fallback) return;
      const idx = prs.indexOf(pr);
      if (idx >= 0) prs[idx] = fallback;
    });
    state.lastPrs = prs;
  } catch (e) {
    errors.github = [errors.github, (e as Error).message].filter(Boolean).join('; ');
    prs = state.lastPrs ?? [];
  }
  const payload = buildSnapshot({ cards, prs, state, config, errors });
  if (seq > lastCompletedRefreshSeq) {
    lastCompletedRefreshSeq = seq;
    state.snapshot = payload;
    state.lastRefreshAt = payload.updatedAt;
  }
  console.log(`refresh: ${cards.length} cards, ${prs.length} prs — jira ${errors.jira ? `error: ${errors.jira}` : 'ok'}, github ${errors.github ? `error: ${errors.github}` : 'ok'}`);
  return payload;
}

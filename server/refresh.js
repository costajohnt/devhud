import { cardState } from './state.js';
import { linkPrsToCards, unlinked } from './link.js';
import { classifyCard, isTodo, isDone } from './classify.js';
import { fetchJiraCards } from './jira.js';
import { fetchPrs, enrichPr } from './github.js';

const DAY = 86400000;

const prView = (p) => p && {
  repo: p.repo, number: p.number, url: p.url, branch: p.branch,
  state: p.state, ciStatus: p.ciStatus, reviewState: p.reviewState,
};

// Full comment history for the detail panel's "Comments" section: last 10
// comments merged from both sources, newest first, regardless of whether
// classifyCard already flagged them as "new". Independent of newComments,
// which is seen-horizon-filtered and drives attention/badges.
const itemComments = (card, pr) => {
  const fromPr = (pr?.comments ?? []).map(c => ({ source: 'github', author: c.author, body: c.body?.slice(0, 300) ?? '', createdAt: c.createdAt }));
  const fromJira = (card.comments ?? []).map(c => ({ source: 'jira', author: c.author || c.authorId, body: c.body?.slice(0, 300) ?? '', createdAt: c.createdAt }));
  return [...fromPr, ...fromJira]
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
    .slice(0, 10);
};

// Upsert every fetched PR into the lifecycle log, keyed by "org/repo#num".
// Runs on every refresh (real and demo) so prLog always reflects the latest
// known state of every PR ever seen. Never deletes entries — history only.
// closedAt only fires for closed-and-unmerged PRs; a merged PR gets mergedAt,
// not closedAt, mirroring oss-autopilot's Opened/Merged/Closed series.
function upsertPrLog(state, prs) {
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

export function buildSnapshot({ cards, prs, state, config, errors }) {
  const { statuses } = config.jira;
  const username = config.github.username;
  state.prLog ??= {};
  upsertPrLog(state, prs);
  const linked = linkPrsToCards(cards, prs, config.jira.projectKey);

  const buckets = { needs_attention: [], in_progress: [], waiting_review: [], in_qa: [] };
  const todo = [], mergedCards = [], newlyMerged = [];

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
      if (isDone(card, statuses)) {
        mergedCards.push({ key: card.key, summary: card.summary, jiraUrl: card.url, pr: prView(pr), mergedAt: pr.mergedAt });
        continue; // done + merged: off the board
      }
    }
    if (isDone(card, statuses)) continue;

    const { bucket, attention, newComments } = classifyCard({ card, pr, cs, statuses, username });
    const lastTs = [card.updatedAt, pr?.updatedAt].filter(Boolean).sort().pop();
    buckets[bucket].push({
      key: card.key, summary: card.summary, jiraStatus: card.status, jiraUrl: card.url,
      bucket, attention, newComments, comments: itemComments(card, pr), pr: prView(pr),
      createdAt: card.createdAt, updatedAt: card.updatedAt,
      daysSinceActivity: lastTs ? Math.max(0, Math.floor((Date.now() - Date.parse(lastTs)) / DAY)) : null,
    });
  }

  const weekAgo = Date.now() - 7 * DAY;
  const recentActivity = prs
    .filter(p => p.mergedAt && Date.parse(p.mergedAt) > weekAgo)
    .map(p => ({ type: 'merged', label: p.title || `${p.repo}#${p.number}`, url: p.url, date: p.mergedAt }))
    .sort((a, b) => b.date.localeCompare(a.date));

  return {
    updatedAt: new Date().toISOString(),
    errors: { jira: errors.jira ?? null, github: errors.github ?? null },
    buckets, todo,
    unlinkedPrs: unlinked(prs, linked).filter(p => p.state === 'open')
      .map(p => ({ repo: p.repo, number: p.number, url: p.url, title: p.title, state: p.state })),
    mergedCards, mergedTotal: state.mergedTotal, newlyMerged, recentActivity,
    prLog: Object.values(state.prLog),
  };
}

// On a source failure, reuse that source's last-known-good data instead of
// blanking the board — a transient Jira/GitHub outage shouldn't wipe out
// everything the user was tracking.
export async function refresh({ config, state }) {
  const errors = {};
  let cards, prs;
  if (config.demo) {
    // Demo mode: canned data through the real pipeline, no network.
    const { demoCards, demoPrs } = await import('./demo.js');
    cards = demoCards(config.jira);
    prs = demoPrs(config.github);
    const payload = buildSnapshot({ cards, prs, state, config, errors });
    state.snapshot = payload;
    state.lastRefreshAt = payload.updatedAt;
    console.log(`refresh (demo): ${cards.length} cards, ${prs.length} prs`);
    return payload;
  }
  try {
    cards = await fetchJiraCards(config.jira);
    state.lastCards = cards;
  } catch (e) {
    errors.jira = e.message;
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
    if (failed.length) errors.github = [errors.github, ...failed.map(f => f.reason?.message)].filter(Boolean).join('; ');
    // Replace any PR whose enrichment rejected with its last-known-good
    // counterpart (matched by repo+number) so a transient detail-fetch
    // failure doesn't strip CI/review/comment data the board already had.
    results.forEach((r, i) => {
      if (r.status !== 'rejected') return;
      const pr = toEnrich[i];
      const fallback = (state.lastPrs ?? []).find(lp => lp.repo === pr.repo && lp.number === pr.number);
      if (!fallback) return;
      const idx = prs.indexOf(pr);
      if (idx >= 0) prs[idx] = fallback;
    });
    state.lastPrs = prs;
  } catch (e) {
    errors.github = [errors.github, e.message].filter(Boolean).join('; ');
    prs = state.lastPrs ?? [];
  }
  const payload = buildSnapshot({ cards, prs, state, config, errors });
  state.snapshot = payload;
  state.lastRefreshAt = payload.updatedAt;
  console.log(`refresh: ${cards.length} cards, ${prs.length} prs — jira ${errors.jira ? `error: ${errors.jira}` : 'ok'}, github ${errors.github ? `error: ${errors.github}` : 'ok'}`);
  return payload;
}

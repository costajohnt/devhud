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

export function buildSnapshot({ cards, prs, state, config, errors }) {
  const { statuses } = config.jira;
  const username = config.github.username;
  const linked = linkPrsToCards(cards, prs, config.jira.projectKey);

  const buckets = { needs_attention: [], in_progress: [], waiting_review: [], in_qa: [] };
  const todo = [], mergedCards = [], newlyMerged = [];

  for (const card of cards) {
    if (isTodo(card, statuses)) { todo.push({ key: card.key, summary: card.summary, jiraUrl: card.url, createdAt: card.createdAt }); continue; }
    const pr = linked.get(card.key) ?? null;
    const cs = cardState(state, card.key);

    if (pr?.state === 'merged') {
      const id = `${pr.repo}#${pr.number}`;
      if (!state.celebrated.includes(id)) {
        state.celebrated.push(id);
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
      bucket, attention, newComments, pr: prView(pr),
      createdAt: card.createdAt, updatedAt: card.updatedAt,
      daysSinceActivity: lastTs ? Math.floor((Date.now() - Date.parse(lastTs)) / DAY) : null,
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
  };
}

export async function refresh({ config, state }) {
  const errors = {};
  let cards = [], prs = [];
  try { cards = await fetchJiraCards(config.jira); } catch (e) { errors.jira = e.message; }
  try {
    const gh = await fetchPrs(config.github);
    prs = gh.prs;
    if (gh.errors.length) errors.github = gh.errors.join('; ');
    const linked = linkPrsToCards(cards, prs, config.jira.projectKey);
    const results = await Promise.allSettled([...new Set(linked.values())].map(p => enrichPr(p, config.github)));
    const failed = results.filter(r => r.status === 'rejected');
    if (failed.length) errors.github = [errors.github, ...failed.map(f => f.reason?.message)].filter(Boolean).join('; ');
  } catch (e) { errors.github = [errors.github, e.message].filter(Boolean).join('; '); }
  const payload = buildSnapshot({ cards, prs, state, config, errors });
  state.snapshot = payload;
  state.lastRefreshAt = payload.updatedAt;
  return payload;
}

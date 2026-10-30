import { cardState } from './state.ts';
import { linkPrsToCards, unlinked } from './link.ts';
import { buildQueue } from './queue.ts';
import { PR_ACK_REASONS, REASONS, isReason } from './reasons.ts';
import { CARD_STATE_RETENTION_DAYS, prAttention, applyAcks, classifyCard, markReachedTest, isTodo, isDone, isCanceled, isBlocked, githubNewComment, jiraNewComment } from './classify.ts';
import { fetchJiraCards, fetchFiledCards, doneWatermark } from './jira.ts';
import { fetchPrs, fetchReviewRequests, enrichPr, isThrottleMessage, resetGithubStats, formatGithubStats } from './github.ts';
import type { Card, Pr, PrRef, State, Config, Snapshot, Bucket, Item, ActivityEntry, PrLogEntry, NewComment, FiledCard, FiledMeta, ReviewRequest, DoneCard, QueueEntry } from './types.ts';

const DAY = 86400000;

// How long a doneCelebrated entry is kept after its card stops appearing in
// fetches. Deliberately far wider than the Done watermark lag: the gap
// is the safety margin against a double celebration. See the prune in
// pruneState.
export const CELEBRATION_RETENTION_DAYS = 90;
// Per-card state (pins, horizons, acks) for a card absent from every fetch
// for CARD_STATE_RETENTION_DAYS (classify.ts) is dropped; a card that comes
// back starts fresh (audit M20).
export { CARD_STATE_RETENTION_DAYS };

// Which repos' data is degraded this refresh; 'all' when the whole fetch
// failed, null when nothing is.
type Degraded = Set<string> | 'all' | null;

const prView = (p: Pr | null): PrRef | null => p && {
  repo: p.repo, number: p.number, url: p.url, branch: p.branch,
  state: p.state, ciStatus: p.ciStatus, ciNewFailures: p.ciNewFailures,
  ...(p.ciBasePending ? { ciBasePending: true } : {}), reviewState: p.reviewState, isDraft: p.isDraft,
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

export function buildSnapshot({ cards, prs, state, config, errors, degradedPrRepos, degradedRequestRepos = 'all', linked = linkPrsToCards(cards, prs), filed, reviewRequests = [], dataAsOf = new Date().toISOString() }: {
  cards: Card[]; prs: Pr[]; state: State; config: Config; errors: { jira?: string; github?: string };
  // When the data was read (see Snapshot.dataAsOf). refresh() passes the time
  // before its first fetch; direct callers get the build start.
  dataAsOf?: string;
  reviewRequests?: ReviewRequest[];
  // Cards this user reported (jira.ts fetchFiledCards). Optional so callers
  // that don't fetch them (tests, direct use) get an empty list.
  filed?: FiledCard[];
  // Which repos' PR data is degraded this refresh ('all' = the whole GitHub
  // fetch failed). Callers that don't track it (tests, direct use) default to
  // 'all' whenever errors.github is set — conservative, never prunes acks on
  // any error. refresh() passes the precise set so one permanently broken
  // repo in the config doesn't disable ack-pruning for every other repo's
  // cards forever.
  degradedPrRepos?: Set<string> | 'all';
  // Repos (lowercased) whose review-request search failed this refresh
  // ('all' = the whole search failed). Their dismissals survive the prune.
  // Defaults to 'all': callers that don't fetch review requests never prune
  // dismissals.
  degradedRequestRepos?: Set<string> | 'all';
  // PR-to-card links. refresh() already computed them to choose what to
  // enrich and passes them through; direct callers get them computed here.
  linked?: Map<string, Pr>;
}): Snapshot {
  state.prLog ??= {};
  state.doneCelebrated ??= [];
  upsertPrLog(state, prs);

  // Both state-based attention reasons derive from PR data; when a card's PR
  // data is degraded this refresh, classify's ack-pruning must not treat
  // "reason missing from this refresh" as "reason cleared" — that would wipe
  // acks a healthy refresh would have kept.
  const degraded: Degraded = degradedPrRepos ?? (errors.github ? 'all' : null);

  // The first refresh after state.ownPrs existed treats existing comments on
  // card-less PRs as seen instead of flooding the queue with their history.
  const firstOwnPrs = state.ownPrs === undefined;
  state.ownPrs ??= {};
  const nowIso = new Date().toISOString();

  const board = classifyCards({ cards, linked, state, config, degraded });
  const doneLedger = mergeDoneLedger(state, board.doneCards, board.notDone);
  const unlinkedPrs = buildUnlinkedPrs({ prs, linked, state, config, degraded, initialSeen: firstOwnPrs ? nowIso : null });

  // A dismissed review request stays hidden until the PR changes after the
  // dismissal (a new push, comment or re-request bumps updatedAt).
  const requests = reviewRequests.map(rr => {
    const d = state.prs?.[rr.id]?.dismissedAt;
    return { ...rr, dismissed: !!d && !(Date.parse(rr.updatedAt) > Date.parse(d)) };
  });

  const { buckets, todo, blocked, newlyDone } = board;
  const statuses = config.jira.statuses;

  // Stamp state-reason entries the queue shows for the first time. The first
  // refresh after state.queueSeen existed seeds from the old `at` (updatedAt)
  // so nothing on an upgraded board jumps to "just now".
  const firstQueueSeen = state.queueSeen === undefined;
  state.queueSeen ??= {};
  const unstamped = buildQueue(buckets, statuses, requests, unlinkedPrs);
  for (const e of unstamped) {
    if (isReason(e.reason) && REASONS[e.reason].stateful) state.queueSeen[e.id] ??= firstQueueSeen ? (e.at ?? nowIso) : nowIso;
  }

  pruneState({ state, cards, prs, nowIso, jiraFailed: !!errors.jira, doneCards: board.doneCards, degraded, reviewRequests, degradedRequestRepos, queue: unstamped, buckets });

  return {
    updatedAt: new Date().toISOString(),
    dataAsOf,
    errors: { jira: errors.jira ?? null, github: errors.github ?? null },
    buckets, queue: buildQueue(buckets, statuses, requests, unlinkedPrs, state.queueSeen), reviewRequests: requests, todo, blocked,
    unlinkedPrs,
    // Done page and counter both come from the lifetime ledger, so they agree
    // by construction. Deriving the count from a single refresh made it shrink
    // as cards aged out of the fetch window; deriving it from the old
    // append-only doneCelebrated ledger let it drift above the rows (a header
    // reading 32 over a 4-row table). doneCelebrated stays scoped to the one
    // job it is good for: celebrate-once dedup via newlyDone.
    doneCards: doneLedger, doneTotal: doneLedger.length, newlyDone, recentActivity: buildActivity(prs, buckets),
    prLog: Object.values(state.prLog) as PrLogEntry[],
    filed: filed ?? [],
  };
}

// Routes every fetched card: off the board (canceled, Todo, Blocked, Done)
// or into a bucket via classifyCard, syncing each card's seen horizon and PR
// acks with state.ownPrs on the way.
function classifyCards({ cards, linked, state, config, degraded }: {
  cards: Card[]; linked: Map<string, Pr>; state: State; config: Config; degraded: Degraded;
}) {
  const { statuses } = config.jira;
  const username = config.github.username;
  // Multi-identity: pass all configured usernames so comments from any of them
  // are treated as "self" in classifyCard's new-comments check (#108).
  const usernames = config.github.usernames;
  const ignoreAuthors = config.ignoreAuthors ?? [];
  const buckets: Record<Bucket, Item[]> = { needs_attention: [], in_progress: [], self_review: [], waiting_review: [], mergeable: [], qa_ready: [], in_qa: [] };
  const todo: Snapshot['todo'] = [];
  const blocked: Snapshot['blocked'] = [];
  const doneCards: DoneCard[] = [], newlyDone: string[] = [];
  // Cards seen this refresh that are NOT done (reopened, or canceled after
  // reaching Done). They must leave the lifetime ledger, or a card QA kicks
  // back stays counted as complete forever.
  const notDone = new Set<string>();

  // One seen-comment horizon and set of PR acks per open PR, whether or not
  // a card links it: state.ownPrs[ref] is kept for every open PR and synced
  // both ways with the linking card's CardState, so a PR that gains or loses
  // its card (reassigned, relinked) keeps what was already seen and acked.
  const ownPrs = state.ownPrs!;
  const later = (a: string | null | undefined, b: string | null | undefined): string | null =>
    !a ? b ?? null : !b ? a : Date.parse(b) > Date.parse(a) ? b : a;
  // PRs linked by a card that stays on the board this refresh. An off-board
  // card must not clear the acks of a PR another on-board card still links.
  const onBoardRefs = new Set<string>();
  for (const card of cards) {
    const pr = linked.get(card.key);
    if (pr && !(isCanceled(card, statuses) || isBlocked(card, statuses) || isDone(card, statuses))) onBoardRefs.add(`${pr.repo}#${pr.number}`);
  }

  for (const card of cards) {
    // Canceled work is neither active nor complete — drop it from every bucket,
    // the Todo list, the Done page, and all counts.
    // Off-board routes (canceled/todo/blocked/done) never reach classifyCard, so its
    // ack-pruning can't run for them; forget acks here so a card that later
    // returns to the board (e.g. QA rejects a Done card back to In Progress)
    // re-triggers on a still-true reason instead of staying muted forever.
    // The test must match the routing below exactly: a To Do card with a
    // linked PR stays on the board, and wiping its acks here un-acked it on
    // every refresh. The PR's own ack copy (ownPrs) is cleared too, or the
    // sync below merges the old acks back when the card returns.
    const pr = linked.get(card.key) ?? null;
    if (isCanceled(card, statuses) || (isTodo(card, statuses) && !pr) || isBlocked(card, statuses) || isDone(card, statuses)) {
      const cs = state.cards[card.key];
      if (cs?.ackedReasons) cs.ackedReasons = null;
      const ref = pr ? `${pr.repo}#${pr.number}` : null;
      const own = ref && !onBoardRefs.has(ref) ? ownPrs[ref] : undefined;
      if (own?.ackedReasons) own.ackedReasons = null;
    }
    if (!isDone(card, statuses)) notDone.add(card.key);
    if (isCanceled(card, statuses)) continue;
    // Blocked is name-only and more specific than the To Do category, so it
    // wins if a project files the status under 'new'. Unlike todo, a linked
    // PR does not keep the card on the board: Jira saying blocked is the
    // lifecycle statement.
    if (isBlocked(card, statuses)) { blocked.push({ key: card.key, summary: card.summary, jiraUrl: card.url, createdAt: card.createdAt }); continue; }
    if (isTodo(card, statuses) && !pr) { todo.push({ key: card.key, summary: card.summary, jiraUrl: card.url, createdAt: card.createdAt }); continue; }
    // lastSeenAt is stamped for every fetched card in pruneState.
    const cs = cardState(state, card.key);

    // A merged PR is supporting context, not completion: it rides along on the
    // active card via prView(pr) (the board's "Merged" pill, the detail panel),
    // and stays on the board so QA can still reject it. Completion follows the
    // Jira Done category below — a done card is celebrated once and drops off
    // the active board.
    if (isDone(card, statuses)) {
      // Done counts as "went through QA" for merged_not_in_test (H1): a card
      // QA or a reopen sends back to In Progress must not be re-flagged on
      // the merge it already shipped with.
      markReachedTest(cs, new Date().toISOString());
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
    const prRef = pr && `${pr.repo}#${pr.number}`;
    const own = prRef ? ownPrs[prRef] : undefined;
    if (own) {
      cs.lastSeenPr = later(cs.lastSeenPr, own.lastSeenPr);
      const merged = [...new Set([...(cs.ackedReasons ?? []), ...(own.ackedReasons ?? [])])];
      cs.ackedReasons = merged.length ? merged : null;
    }
    const prDegraded = degraded === 'all'
      || (degraded !== null && (pr ? degraded.has(pr.repo) : degraded.size > 0));
    const { bucket, attention, newComments } = classifyCard({ card, pr, cs, statuses, username, usernames, ignoreAuthors, prDegraded, postedCommentIds: state.postedCommentIds ?? [] });
    if (prRef && pr?.state === 'open') {
      const acks = (cs.ackedReasons ?? []).filter(r => PR_ACK_REASONS.includes(r));
      ownPrs[prRef] = { lastSeenPr: cs.lastSeenPr, ackedReasons: acks.length ? acks : null };
    }
    const lastTs = [card.updatedAt, pr?.updatedAt].filter((x): x is string => Boolean(x)).sort().pop();
    buckets[bucket].push({
      key: card.key, summary: card.summary, jiraStatus: card.status, jiraUrl: card.url,
      fixVersions: card.fixVersions ?? [],
      bucket, attention, newComments, comments: itemComments(card, pr), pr: prView(pr),
      // Read after classifyCard, whose lastStatus rule clears a pin on a status
      // transition, so this reflects the pin the board is actually honoring.
      pinned: cs.override !== null, pinnedAt: cs.overrideAt,
      createdAt: card.createdAt, updatedAt: card.updatedAt,
      daysSinceActivity: lastTs ? Math.max(0, Math.floor((Date.now() - Date.parse(lastTs)) / DAY)) : null,
    });
  }
  return { buckets, todo, blocked, doneCards, newlyDone, notDone };
}

// Lifetime Done ledger, oss-autopilot's mergedPRs pattern: store every Done
// card locally, fetch only what changed since the watermark, and merge by
// key. This refresh's rows win (status/summary/PR can change after Done);
// anything now non-Done is evicted. Result is an all-time list, so the
// counter is the length of a complete list rather than of one fetch page.
function mergeDoneLedger(state: State, doneCards: DoneCard[], notDone: Set<string>): DoneCard[] {
  const ledgerByKey = new Map((state.doneLedger ?? []).map(d => [d.key, d]));
  for (const key of notDone) ledgerByKey.delete(key);
  for (const d of doneCards) ledgerByKey.set(d.key, d);
  const doneLedger = [...ledgerByKey.values()]
    .sort((a, b) => (b.doneAt ?? '').localeCompare(a.doneAt ?? ''));
  state.doneLedger = doneLedger;
  return doneLedger;
}

// Recent Activity: merges, closures and new comments from the last 7 days,
// newest first.
function buildActivity(prs: Pr[], buckets: Record<Bucket, Item[]>): ActivityEntry[] {
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
  // Comments surface from the board items just built: each item's
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
  return [...mergedActivity, ...closedActivity, ...commentActivity]
    .sort((a, b) => b.date.localeCompare(a.date));
}

// The user's open PRs with no card still need them: same PR reasons as a
// card's PR, with their own seen horizon and acks in state.ownPrs.
// initialSeen is the horizon a PR seen for the first time starts from.
function buildUnlinkedPrs({ prs, linked, state, config, degraded, initialSeen }: {
  prs: Pr[]; linked: Map<string, Pr>; state: State; config: Config; degraded: Degraded; initialSeen: string | null;
}): Snapshot['unlinkedPrs'] {
  const ownPrs = state.ownPrs!;
  const ignoreAuthors = config.ignoreAuthors ?? [];
  const selfNames = new Set((config.github.usernames ?? [config.github.username]).map(u => u.toLowerCase()));
  return unlinked(prs, linked).filter(p => p.state === 'open').map(p => {
    const ref = `${p.repo}#${p.number}`;
    const ps = (ownPrs[ref] ??= { lastSeenPr: initialSeen });
    const raw = prAttention(p, ps.lastSeenPr, selfNames, ignoreAuthors);
    const { visible, acked } = applyAcks(raw.attention, ps.ackedReasons, degraded === 'all' || !!degraded?.has(p.repo));
    ps.ackedReasons = acked;
    return {
      repo: p.repo, number: p.number, url: p.url, title: p.title, state: p.state,
      attention: visible, newComments: visible.includes('new_pr_comments') ? raw.newComments.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '')) : [],
      pr: prView(p)!, updatedAt: p.updatedAt,
    };
  });
}

// Every retention rule for per-entity state, run once after the snapshot is
// built. Each one skips whatever a failed source can't vouch for this
// refresh, so an outage never reads as "gone".
function pruneState({ state, cards, prs, nowIso, jiraFailed, doneCards, degraded, reviewRequests, degradedRequestRepos, queue, buckets }: {
  state: State; cards: Card[]; prs: Pr[]; nowIso: string; jiraFailed: boolean; doneCards: DoneCard[];
  degraded: Degraded; reviewRequests: ReviewRequest[]; degradedRequestRepos: Set<string> | 'all';
  queue: QueueEntry[]; buckets: Record<Bucket, Item[]>;
}): void {
  // state.cards used to grow forever: every card ever classified, plus any
  // key an ack or move named. Stamp the cards this fetch returned, give
  // unstamped entries (older state files, acks on unknown keys) a first
  // sighting, and drop entries unseen for the retention window. No deletes
  // when the Jira fetch failed (the cards then came from lastCards); those
  // still count as seen, which keeps entries alive through an outage.
  const fetchedKeys = new Set(cards.map(c => c.key));
  const cardCutoff = Date.now() - CARD_STATE_RETENTION_DAYS * DAY;
  for (const [key, cs] of Object.entries(state.cards)) {
    if (fetchedKeys.has(key) || !cs.lastSeenAt) cs.lastSeenAt = nowIso;
    else if (!jiraFailed && Date.parse(cs.lastSeenAt) < cardCutoff) delete state.cards[key];
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
  const fetchedDone = new Set(doneCards.map(d => d.key));
  const ledgerCutoff = Date.now() - CELEBRATION_RETENTION_DAYS * DAY;
  state.doneCelebrated = state.doneCelebrated.filter(e => {
    if (fetchedDone.has(e.id)) return true;
    const at = e.at ? Date.parse(e.at) : NaN;
    return Number.isNaN(at) || at > ledgerCutoff;
  });

  // Card-less PR state lives while the PR is open; a repo whose fetch failed
  // keeps its entries.
  const ownPrs = state.ownPrs!;
  const openRefs = new Set(prs.filter(p => p.state === 'open').map(p => `${p.repo}#${p.number}`));
  for (const ref of Object.keys(ownPrs)) {
    const repo = ref.slice(0, ref.lastIndexOf('#'));
    if (!openRefs.has(ref) && degraded !== 'all' && !degraded?.has(repo)) delete ownPrs[ref];
  }

  // Review-request dismissals live while the request does; a repo whose
  // search failed keeps its dismissals.
  if (state.prs && degradedRequestRepos !== 'all') {
    const live = new Set(reviewRequests.map(r => r.id));
    for (const id of Object.keys(state.prs)) {
      if (!live.has(id) && !degradedRequestRepos.has(id.slice(0, id.lastIndexOf('#')).toLowerCase())) delete state.prs[id];
    }
  }

  // Queue first-seen times live while their entry is in the queue, so a
  // reason that leaves (cleared or acked) and comes back starts over. An
  // entry missing only because a source failed keeps its time: nothing on a
  // Jira failure, and on a GitHub failure nothing whose PR data is degraded,
  // using classifyCards' rule (a card with no PR counts as degraded under
  // any degradation, and so does a card no longer on the board).
  if (!jiraFailed && degraded !== 'all') {
    const live = new Set(queue.map(e => e.id));
    const boardPr = new Map(Object.values(buckets).flat().map(i => [i.key, i.pr?.repo ?? null]));
    for (const id of Object.keys(state.queueSeen!)) {
      if (live.has(id)) continue;
      const key = id.slice(0, id.lastIndexOf(':'));
      const repo = key.includes('#') ? key.slice(0, key.lastIndexOf('#')) : boardPr.get(key);
      if (degraded?.size && (repo ? degraded.has(repo) : true)) continue;
      delete state.queueSeen![id];
    }
  }
}


// How close an enrichment may sit to the updatedAt it read before the
// same-second hole (see the enrichment skip in refresh()) makes it
// unconfirmed (#75). Two seconds covers the second-granularity rounding plus
// modest clock skew between GitHub and this host; a larger skew is why the
// caller also records enrichConfirmed rather than trusting this test alone.
const UNCONFIRMED_ENRICHMENT_MS = 2_000;

function enrichmentUnconfirmed(last: Pr): boolean {
  if (last.enrichConfirmed) return false;
  if (!last.enrichedAt) return true;
  return Date.parse(last.updatedAt) >= Date.parse(last.enrichedAt) - UNCONFIRMED_ENRICHMENT_MS;
}

// While the base branch's CI is still running, discovery cannot say whether a
// failing PR's red checks are its own (#86). Keep the previous refresh's
// verdict for the same PR rather than flipping the card into Needs Attention
// for the length of the base run; with no earlier verdict, ciBasePending
// alone makes classify hold off. Only a known verdict is carried: an earlier
// unknown has nothing to add.
// ponytail: carries across a push to the PR too (no head SHA on Pr); the
// next refresh after the base finishes corrects it.
export function carryOverCiVerdicts(prs: Pr[], previous: Map<string, Pr>): void {
  for (const p of prs) {
    if (!p.ciBasePending || p.ciNewFailures) continue;
    const last = previous.get(`${p.repo}#${p.number}`);
    if (last?.state === 'open' && last.ciStatus === 'failing' && last.ciNewFailures) p.ciNewFailures = last.ciNewFailures;
  }
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

// The incremental Filed fetch never drops rows, so do a full one at least
// this often to shed deleted, moved and re-reported cards.
export const FILED_FULL_FETCH_MS = 24 * 60 * 60 * 1000;

// Whether this refresh's Filed fetch should be a delta over `cached` or a
// full refetch. Full when there is no provenance stamp (first run, or a
// state file from before the stamp), when the stamp is older than
// FILED_FULL_FETCH_MS (or unparseable / in the future), or when the cached
// list belongs to a different Jira account or site (`sameScope` false: the
// cached list is then not a valid fallback either). `meta` is the stamp to
// store once a full fetch succeeds.
export function filedFetchPlan(prior: FiledMeta | undefined, jira: { accountId: string; baseUrl?: string },
  cached: FiledCard[], now = Date.now()): { full: boolean; sameScope: boolean; previous: FiledCard[]; meta: FiledMeta } {
  const meta: FiledMeta = { fullFetchAt: new Date(now).toISOString(), accountId: jira.accountId, baseUrl: jira.baseUrl ?? null };
  // No stamp means unknown provenance: refetch in full, but keep the cached
  // list as last-known-good if that fetch fails (pre-stamp state files).
  const sameScope = !prior || (prior.accountId === meta.accountId && (prior.baseUrl ?? null) === meta.baseUrl);
  const age = prior ? now - Date.parse(prior.fullFetchAt) : NaN;
  const full = !prior || !sameScope || !(age >= 0 && age < FILED_FULL_FETCH_MS);
  return { full, sameScope, previous: full ? [] : cached, meta };
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
  // Taken before the first fetch: nothing read below can be newer than this,
  // so it is safe as the ack horizon (Snapshot.dataAsOf).
  const fetchStart = new Date().toISOString();
  if (config.demo) {
    // Demo mode: canned data through the real pipeline, no network.
    const { demoCards, demoPrs, demoFiled, demoReviewRequests } = await import('./demo.ts');
    const cards = demoCards(config.jira);
    const prs = demoPrs(config.github);
    const payload = buildSnapshot({ cards, prs, state, config, errors, filed: demoFiled(config.jira), reviewRequests: demoReviewRequests(config.github), dataAsOf: fetchStart });
    state.snapshot = payload;
    state.lastRefreshAt = payload.updatedAt;
    if (!quiet) console.log(`refresh (demo): ${cards.length} cards, ${prs.length} prs`);
    return payload;
  }
  resetGithubStats();
  let jiraOk = false;
  let cards: Card[];
  try {
    cards = await fetchJiraCards(config.jira, doneWatermark(state.doneLedger ?? []));
    jiraOk = true;
  } catch (e) {
    errors.jira = (e as Error).message;
    cards = state.lastCards ?? [];
  }
  const filed = await readFiled(config, state);
  if (filed.error) errors.jira = [errors.jira, `filed cards: ${filed.error}`].filter(Boolean).join('; ');
  const gh = await readPrs(config, state, cards);
  const rr = await readReviewRequests(config, state);
  // Collected rather than concatenated as we go, so the compose step below can
  // tell a throttle apart from a real failure and keep both legible (#69).
  const githubErrors = [...gh.errors, ...rr.errors];
  // A throttle that survives gh()'s retries is the least alarming failure the
  // banner can carry: the last-known-good splices keep the board usable
  // and the next tick usually clears it, so every throttled path collapses into
  // one calm sentence instead of pasting a URL and a JSON blob at the user
  // (#69). Any non-throttle failure keeps its own message — that one still
  // needs reading.
  const throttled = githubErrors.filter(isThrottleMessage);
  const realFailures = githubErrors.filter(m => !isThrottleMessage(m));
  if (throttled.length) realFailures.unshift('GitHub throttled this refresh (rate limit) — showing last known data.');
  if (realFailures.length) errors.github = realFailures.join('; ');
  // Any source that fell back served last-known-good data from an earlier
  // read, so the horizon must not move past that earlier read.
  const prevAsOf = state.snapshot?.dataAsOf ?? state.snapshot?.updatedAt ?? null;
  const fellBack = Boolean(errors.jira || errors.github);
  const dataAsOf = fellBack && prevAsOf && Date.parse(prevAsOf) < Date.parse(fetchStart) ? prevAsOf : fetchStart;
  const payload = buildSnapshot({ cards, prs: gh.prs, linked: gh.linked, state, config, errors, degradedPrRepos: gh.degraded, filed: filed.cards, reviewRequests: rr.requests, degradedRequestRepos: rr.degraded, dataAsOf });
  state.snapshot = payload;
  state.lastRefreshAt = payload.updatedAt;
  // The last-known-good caches are the outage fallback; only a source that
  // answered this refresh may overwrite its cache. Filed cards and review
  // requests are stored as served: a failed fetch already served its own
  // fallback (or nothing, for another Jira account's list).
  if (jiraOk) state.lastCards = cards;
  if (gh.ok) state.lastPrs = gh.prs;
  state.lastFiled = filed.cards;
  state.lastReviewRequests = rr.requests;
  if (!quiet) {
    console.log(`refresh: ${cards.length} cards, ${gh.prs.length} prs — jira ${errors.jira ? `error: ${errors.jira}` : 'ok'}, github ${errors.github ? `error: ${errors.github}` : 'ok'}`);
    console.log(`refresh: github ${formatGithubStats()}, ${gh.reused} PRs reused unchanged`);
  }
  return payload;
}

// The filed list is a second Jira query with its own failure: it must not
// take the board down with it, and the board's failure must not blank it.
// Last-known-good is state.lastFiled; a state file from before that field
// falls back to the previous snapshot's list, where it used to live.
// filedFetchPlan decides between a delta over the cached list and a full
// refetch (periodic, or after an account/site change).
async function readFiled(config: Config, state: State): Promise<{ cards: FiledCard[]; error?: string }> {
  const cached = state.lastFiled ?? state.snapshot?.filed ?? [];
  const plan = filedFetchPlan(state.filedMeta, config.jira, cached);
  try {
    const cards = await fetchFiledCards(config.jira, plan.previous);
    if (plan.full) state.filedMeta = plan.meta;
    return { cards };
  } catch (e) {
    // Another account's or site's list is not last-known-good for this one.
    return { cards: plan.sameScope ? cached : [], error: (e as Error).message };
  }
}

// PR discovery plus enrichment, falling back per repo (and wholesale) to
// state.lastPrs. degraded names the repos whose PR data is stale this
// refresh (fetch or enrichment failure — even with a last-known-good
// fallback the data is stale), 'all' when the whole fetch failed; it feeds
// ack-pruning (see buildSnapshot's degradedPrRepos). linked is the
// PR-to-card map enrichment was chosen from, handed on to buildSnapshot;
// absent when the fetch failed and prs came from the cache.
async function readPrs(config: Config, state: State, cards: Card[]): Promise<{
  prs: Pr[]; linked?: Map<string, Pr>; degraded: Set<string> | 'all'; errors: string[]; reused: number; ok: boolean;
}> {
  const errors: string[] = [];
  const degraded = new Set<string>();
  try {
    const gh = await fetchPrs(config.github);
    const prs = gh.prs;
    const previous = new Map((state.lastPrs ?? []).map(p => [`${p.repo}#${p.number}`, p]));
    carryOverCiVerdicts(prs, previous);
    // fetchPrs isolates per-repo failures into "org/repo: msg" strings so one
    // bad repo doesn't blank the others; splice that repo's last-known-good
    // PRs back in from state.lastPrs so it doesn't vanish from the board.
    if (gh.errors.length) {
      errors.push(...gh.errors);
      for (const failedRepo of gh.failedRepos) {
        degraded.add(failedRepo);
        prs.push(...(state.lastPrs ?? []).filter(p => p.repo === failedRepo));
      }
    }
    const linked = linkPrsToCards(cards, prs);
    // Open card-less PRs are enriched too: their comments and reviews feed
    // the TODO queue. Closed/merged card-less PRs never show, so they skip it.
    const candidates = new Set([...linked.values(), ...unlinked(prs, linked).filter(u => u.state === 'open')]);
    const enriched = await enrichChanged([...candidates], previous, config);
    errors.push(...enriched.errors);
    for (const repo of enriched.failedRepos) degraded.add(repo);
    return { prs, linked, degraded, errors, reused: enriched.reused, ok: true };
  } catch (e) {
    errors.push((e as Error).message);
    return { prs: state.lastPrs ?? [], degraded: 'all', errors, reused: 0, ok: false };
  }
}

// Enrich only the candidates that changed since the last refresh. GitHub bumps
// a PR's updated_at for every comment, review, review request, push and
// label — and for an edit or deletion of an existing comment too (checked
// against the REST issues endpoint, 2026-09-05) — so an unchanged
// updatedAt means last refresh's comments and review state still hold;
// CI arrives with discovery (mapPr) and is already fresh on the new
// object. This is what makes a quiet refresh cost one request per repo
// instead of three per linked PR (#72).
//
// One hole in that equality (#75): the timestamps are whole seconds, so a
// comment that lands in the same second as the updatedAt an enrichment
// read leaves updatedAt equal while the comment list is stale, and
// nothing bumps it again until the next PR event, which on a quiet PR can
// be days. An enrichment recorded that close to the updatedAt it saw is
// therefore unconfirmed and is fetched once more. That re-fetch runs a
// whole poll later, so it sees any same-second comment, and the row is
// marked enrichConfirmed for this updatedAt: the time test is not trusted
// to settle on its own, since a host clock running behind GitHub's would
// keep it true on every poll. Only a moved updatedAt (a fresh enrichPr
// result, which carries no flag) reopens the question. A last-known PR
// with no enrichedAt at all (state written before the stamp existed)
// takes the same one-time re-fetch.
async function enrichChanged(candidates: Pr[], previous: Map<string, Pr>, config: Config): Promise<{ errors: string[]; failedRepos: string[]; reused: number }> {
  const toEnrich: Pr[] = [];
  let reused = 0;
  for (const p of candidates) {
    const last = previous.get(`${p.repo}#${p.number}`);
    if (!last?.enriched || last.updatedAt !== p.updatedAt) { toEnrich.push(p); continue; }
    // Same updatedAt as last time: either re-check it once, or reuse it.
    // Either way this updatedAt is confirmed from here on. (A rejected
    // re-check is replaced by its unflagged last-known row below, so the
    // next refresh tries again.)
    p.enrichConfirmed = true;
    if (enrichmentUnconfirmed(last)) { toEnrich.push(p); continue; }
    p.comments = last.comments;
    if (p.reviewState !== 'review_required') p.reviewState = last.reviewState;
    p.enriched = true;
    p.enrichedAt = last.enrichedAt;
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
  const errors = failed.map(f => (f as PromiseRejectedResult).reason?.message).filter((m): m is string => !!m);
  const failedRepos: string[] = [];
  // A PR whose enrichment rejected keeps its fresh discovery object (state,
  // CI, draft flag, base comparison all come from discovery and are
  // current) and takes only the enrichment-derived fields from its
  // last-known-good counterpart (matched by repo+number), so a transient
  // detail-fetch failure neither strips review/comment data the board
  // already had nor freezes a merged PR as open. enrichConfirmed stays
  // unset and the copied enrichedAt predates the fresh updatedAt (or sits
  // within the same-second window of it), so the next refresh re-enriches
  // instead of reusing.
  results.forEach((r, i) => {
    if (r.status !== 'rejected') return;
    const pr = toEnrich[i]!;
    failedRepos.push(pr.repo);
    delete pr.enrichConfirmed;
    const fallback = previous.get(`${pr.repo}#${pr.number}`);
    if (!fallback) return;
    pr.comments = fallback.comments;
    if (pr.reviewState !== 'review_required') pr.reviewState = fallback.reviewState;
    if (fallback.enriched) pr.enriched = true; else delete pr.enriched;
    if (fallback.enrichedAt) pr.enrichedAt = fallback.enrichedAt; else delete pr.enrichedAt;
  });
  return { errors, failedRepos, reused };
}

// Review requests are their own search, isolated per identity like
// fetchPrs is per repo: a repo whose search failed keeps its last-known
// entries (and, in pruneState, its dismissals); every other repo gets this
// refresh's answer. Last-known-good is state.lastReviewRequests, or the
// previous snapshot's list for a state file from before that field.
async function readReviewRequests(config: Config, state: State): Promise<{
  requests: ReviewRequest[]; errors: string[]; degraded: Set<string> | 'all';
}> {
  const previous = state.lastReviewRequests ?? state.snapshot?.reviewRequests ?? [];
  try {
    const rr = await fetchReviewRequests(config.github);
    const failed = new Set(rr.failedRepos.map(r => r.toLowerCase()));
    return { requests: [...rr.requests, ...previous.filter(r => failed.has(r.repo.toLowerCase()))], errors: rr.errors, degraded: failed };
  } catch (e) {
    return { requests: previous, errors: [`review requests: ${(e as Error).message}`], degraded: 'all' };
  }
}

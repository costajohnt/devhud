import type { Card, Pr } from './types.ts';

// key must be preceded by a non-alphanumeric/dash and followed by a
// non-digit, so PROJ-1 doesn't match PROJ-12 and APP-12 doesn't match
// WEBAPP-12-fix.
function mentions(text: string | null | undefined, key: string): boolean {
  if (!text) return false;
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9-])${escaped}(?![0-9])`, 'i').test(text);
}

function prMatchesCard(p: Pr, c: Card): boolean {
  return mentions(p.branch, c.key) || mentions(p.title, c.key) ||
    (p.body ?? '').includes(`/browse/${c.key}`) ||
    (c.description ?? '').includes(p.url);
}

export function linkPrsToCards(cards: Card[], prs: Pr[], _projectKey?: string): Map<string, Pr> {
  const map = new Map<string, Pr>();
  for (const c of cards) {
    const matches = prs.filter(p => prMatchesCard(p, c));
    if (!matches.length) continue;
    matches.sort((a, b) =>
      (a.state === 'open' ? 0 : 1) - (b.state === 'open' ? 0 : 1) ||
      (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    map.set(c.key, matches[0]!);
  }
  return map;
}

export function unlinked(prs: Pr[], linkedMap: Map<string, Pr>): Pr[] {
  const used = new Set([...linkedMap.values()]);
  return prs.filter(p => !used.has(p));
}

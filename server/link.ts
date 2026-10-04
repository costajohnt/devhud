import type { Card, Pr } from './types.ts';

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// key must be preceded by a non-alphanumeric/dash and followed by a
// non-digit, so PROJ-1 doesn't match PROJ-12 and APP-12 doesn't match
// WEBAPP-12-fix.
function mentions(text: string | null | undefined, key: string): boolean {
  if (!text) return false;
  return new RegExp(`(?<![A-Za-z0-9-])${escapeRe(key)}(?![0-9])`, 'i').test(text);
}

// Substring match that must not run on into more digits, so /pull/1 does not
// match inside /pull/12 and /browse/PROJ-1 does not match /browse/PROJ-12.
function containsWhole(text: string | null | undefined, needle: string): boolean {
  if (!text || !needle) return false;
  return new RegExp(`${escapeRe(needle)}(?![0-9])`).test(text);
}

function prMatchesCard(p: Pr, c: Card): boolean {
  return mentions(p.branch, c.key) || mentions(p.title, c.key) ||
    containsWhole(p.body, `/browse/${c.key}`) ||
    containsWhole(c.description, p.url);
}

export function linkPrsToCards(cards: Card[], prs: Pr[], _projectKey?: string): Map<string, Pr> {
  const map = new Map<string, Pr>();
  for (const c of cards) {
    const matches = prs.filter(p => prMatchesCard(p, c));
    if (!matches.length) continue;
    const rank = (p: Pr) => p.state === 'open' ? 0 : p.state === 'merged' ? 1 : 2;
    matches.sort((a, b) => rank(a) - rank(b) || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    map.set(c.key, matches[0]!);
  }
  return map;
}

export function unlinked(prs: Pr[], linkedMap: Map<string, Pr>): Pr[] {
  const used = new Set([...linkedMap.values()]);
  return prs.filter(p => !used.has(p));
}

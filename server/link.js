// key must be followed by a non-digit so PROJ-1 doesn't match PROJ-12
function mentions(text, key) {
  if (!text) return false;
  return new RegExp(`${key}(?![0-9])`, 'i').test(text);
}

function prMatchesCard(p, c) {
  return mentions(p.branch, c.key) || mentions(p.title, c.key) ||
    (p.body ?? '').includes(`/browse/${c.key}`) ||
    (c.description ?? '').includes(p.url);
}

export function linkPrsToCards(cards, prs, _projectKey) {
  const map = new Map();
  for (const c of cards) {
    const matches = prs.filter(p => prMatchesCard(p, c));
    if (!matches.length) continue;
    matches.sort((a, b) =>
      (a.state === 'open' ? 0 : 1) - (b.state === 'open' ? 0 : 1) ||
      (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    map.set(c.key, matches[0]);
  }
  return map;
}

export function unlinked(prs, linkedMap) {
  const used = new Set([...linkedMap.values()]);
  return prs.filter(p => !used.has(p));
}

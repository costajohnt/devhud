import { test, expect, vi } from 'vitest';
import { loadState, saveState, cardState, emptyState, emptySnapshot } from './state.ts';
import { buildSnapshot } from './refresh.ts';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Config } from './types.ts';

const p = join(mkdtempSync(join(tmpdir(), 'jd-')), 'state.json');

test('fresh state when file missing', () => {
  const s = loadState(p);
  expect(s.cards).toEqual({});
  expect(s.celebrated).toEqual([]);
  expect(s.doneCelebrated).toEqual([]);
  expect(s.lastCards).toBeNull();
  expect(s.lastPrs).toBeNull();
  expect(s.prLog).toEqual({});
});

test('round-trips and creates card entries', () => {
  const s = loadState(p);
  cardState(s, 'PROJ-1').override = 'in_qa';
  saveState(p, s);
  const s2 = loadState(p);
  expect(s2.cards['PROJ-1'].override).toBe('in_qa');
});

test('emptyState().cards has a null prototype, and JSON.stringify still serializes it normally', () => {
  const s = emptyState();
  expect(Object.getPrototypeOf(s.cards)).toBeNull();
  cardState(s, 'PROJ-1').override = 'in_qa';
  const json = JSON.stringify(s);
  expect(JSON.parse(json).cards['PROJ-1'].override).toBe('in_qa');
});

test('loadState re-establishes a null prototype on cards after JSON.parse (which always produces a normal-prototype object)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jd-'));
  const path = join(dir, 'state.json');
  const s1 = emptyState();
  cardState(s1, 'PROJ-1').override = 'in_qa';
  saveState(path, s1);
  const s2 = loadState(path);
  expect(Object.getPrototypeOf(s2.cards)).toBeNull();
  expect(s2.cards['PROJ-1']!.override).toBe('in_qa');
});

test('loadState warns and falls back to .bak on a corrupt main file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jd-'));
  const path = join(dir, 'state.json');
  const good = emptyState();
  cardState(good, 'PROJ-9').override = 'in_qa';
  writeFileSync(path + '.bak', JSON.stringify(good));
  writeFileSync(path, '{ not json');
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const s = loadState(path);
  expect(s.cards['PROJ-9'].override).toBe('in_qa');
  expect(warnSpy).toHaveBeenCalled();
  warnSpy.mockRestore();
});

test('saveState skips rotating a corrupt current file, protecting the existing .bak', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jd-'));
  const path = join(dir, 'state.json');
  const good = emptyState();
  cardState(good, 'GOOD').override = 'in_qa';
  writeFileSync(path + '.bak', JSON.stringify(good));
  writeFileSync(path, '{ not json');
  const s = emptyState();
  cardState(s, 'NEW').override = 'in_progress';
  saveState(path, s);
  expect(JSON.parse(readFileSync(path + '.bak', 'utf8')).cards.GOOD.override).toBe('in_qa');
  expect(JSON.parse(readFileSync(path, 'utf8')).cards.NEW.override).toBe('in_progress');
});

test('loadState migrates legacy string celebrated entries to { id, at: null }', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jd-'));
  const path = join(dir, 'state.json');
  writeFileSync(path, JSON.stringify({ ...emptyState(), celebrated: ['org/repo#42', { id: 'org/repo#43', at: '2026-01-01T00:00:00Z' }] }));
  const s = loadState(path);
  expect(s.celebrated).toEqual([
    { id: 'org/repo#42', at: null },
    { id: 'org/repo#43', at: '2026-01-01T00:00:00Z' },
  ]);
});

test('loadState tolerates a state file with no prLog field (pre-existing states)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jd-'));
  const path = join(dir, 'state.json');
  writeFileSync(path, JSON.stringify({ ...emptyState(), prLog: undefined, celebrated: [] }));
  const s = loadState(path);
  expect(s.prLog).toEqual({});
});

test('loadState backfills prLog from celebrated entries missing from it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jd-'));
  const path = join(dir, 'state.json');
  const legacy: Partial<ReturnType<typeof emptyState>> = { ...emptyState(), celebrated: [{ id: 'org/repo#42', at: '2026-01-01T00:00:00Z' }] };
  delete legacy.prLog;
  writeFileSync(path, JSON.stringify(legacy));
  const s = loadState(path);
  expect(s.prLog['org/repo#42']).toEqual({
    id: 'org/repo#42', repo: 'org/repo', openedAt: null, mergedAt: '2026-01-01T00:00:00Z', closedAt: null,
  });
});

test('loadState backfill does not clobber an existing prLog entry for the same id', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jd-'));
  const path = join(dir, 'state.json');
  const state = {
    ...emptyState(),
    celebrated: [{ id: 'org/repo#42', at: '2026-01-01T00:00:00Z' }],
    prLog: { 'org/repo#42': { id: 'org/repo#42', repo: 'org/repo', openedAt: '2025-12-01T00:00:00Z', mergedAt: '2026-01-01T00:00:00Z', closedAt: null } },
  };
  writeFileSync(path, JSON.stringify(state));
  const s = loadState(path);
  expect(s.prLog['org/repo#42'].openedAt).toBe('2025-12-01T00:00:00Z');
});

test('loadState hydrates a missing snapshot.blocked so an old state.json does not crash the board', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jd-'));
  const path = join(dir, 'state.json');
  const raw = emptyState();
  raw.snapshot = emptySnapshot();
  delete (raw.snapshot as { blocked?: unknown }).blocked;
  writeFileSync(path, JSON.stringify(raw));
  const s = loadState(path);
  expect(s.snapshot!.blocked).toEqual([]);
});

test('emptySnapshot() has the same top-level keys as a real buildSnapshot payload', () => {
  const config: Config = { jira: { projectKey: 'PROJ', accountId: 'me', statuses: { todo: 'To Do', inTest: 'In Test', done: 'Done' } }, github: { username: 'me', org: 'o', token: '', repos: [] }, port: 3010, demo: false, writeEnabled: false };
  const real = buildSnapshot({ cards: [], prs: [], state: emptyState(), config, errors: {} });
  expect(Object.keys(emptySnapshot()).sort()).toEqual(Object.keys(real).sort());
});

test('saveState rotates the previous file to .bak before writing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jd-'));
  const path = join(dir, 'state.json');
  const s1 = emptyState();
  cardState(s1, 'A').override = 'in_progress';
  saveState(path, s1);
  const s2 = emptyState();
  cardState(s2, 'B').override = 'in_qa';
  saveState(path, s2);
  expect(JSON.parse(readFileSync(path + '.bak', 'utf8')).cards.A.override).toBe('in_progress');
  expect(JSON.parse(readFileSync(path, 'utf8')).cards.B.override).toBe('in_qa');
});

test('loadState coerces a malformed (non-array) ackedReasons to null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jd-'));
  const path = join(dir, 'state.json');
  writeFileSync(path, JSON.stringify({ cards: { 'P-1': { lastSeenPr: null, lastSeenJira: null, override: null, overrideAt: null, ackedReasons: 'ci_failing' } } }));
  expect(loadState(path).cards['P-1']!.ackedReasons).toBeNull();
});

test('loadState drops a null card entry without discarding the rest of the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jd-'));
  const path = join(dir, 'state.json');
  writeFileSync(path, JSON.stringify({ lastRefreshAt: '2026-07-08T00:00:00Z', cards: { 'P-1': null, 'P-2': { lastSeenPr: null, lastSeenJira: null, override: 'in_qa', overrideAt: null } } }));
  const s = loadState(path);
  expect(s.cards['P-1']).toBeUndefined();
  expect(s.cards['P-2']!.override).toBe('in_qa');
  expect(s.lastRefreshAt).toBe('2026-07-08T00:00:00Z');
});

// --- crash durability: state.json must never be absent mid-save ---

// Contract check, not a regression guard: copy-vs-rename differs only in
// what a crash mid-save leaves behind, which isn't observable from outside.
// The recovery test below is what actually holds that fix in place.
test('saveState leaves both a live state.json and a prior-generation .bak', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jd-durable-'));
  const path = join(dir, 'state.json');
  const s = emptyState();
  cardState(s, 'PROJ-1').override = 'in_qa';
  saveState(path, s);
  expect(existsSync(path)).toBe(true);

  cardState(s, 'PROJ-2').override = 'mergeable';
  saveState(path, s);

  expect(existsSync(path)).toBe(true);
  expect(existsSync(path + '.bak')).toBe(true);
  const bak = JSON.parse(readFileSync(path + '.bak', 'utf8')) as { cards: Record<string, { override?: string }> };
  expect(bak.cards['PROJ-1']?.override).toBe('in_qa'); // .bak holds the prior generation
  expect(bak.cards['PROJ-2']).toBeUndefined();
  expect(loadState(path).cards['PROJ-2']?.override).toBe('mergeable');
});

test('loadState recovers from .bak when state.json is missing entirely', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jd-recover-'));
  const path = join(dir, 'state.json');
  const s = emptyState();
  cardState(s, 'PROJ-9').override = 'qa_ready';
  saveState(path, s);
  saveState(path, s); // second save populates .bak

  // Simulate a crash that left only the backup behind.
  rmSync(path);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    expect(loadState(path).cards['PROJ-9']?.override).toBe('qa_ready');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('recovered from'));
  } finally {
    warn.mockRestore();
  }
});

test('a genuinely first-run load stays silent and empty', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'jd-firstrun-')), 'state.json');
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    expect(loadState(path).cards).toEqual({});
    expect(warn).not.toHaveBeenCalled();
  } finally {
    warn.mockRestore();
  }
});

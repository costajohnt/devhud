import { test, expect, vi } from 'vitest';
import { loadState, saveState, cardState, emptyState } from './state.js';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const p = join(mkdtempSync(join(tmpdir(), 'jd-')), 'state.json');

test('fresh state when file missing', () => {
  const s = loadState(p);
  expect(s.cards).toEqual({});
  expect(s.celebrated).toEqual([]);
  expect(s.mergedTotal).toBe(0);
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
  const legacy = { ...emptyState(), celebrated: [{ id: 'org/repo#42', at: '2026-01-01T00:00:00Z' }] };
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

import { test, expect } from 'vitest';
import { loadState, saveState, cardState } from './state.js';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const p = join(mkdtempSync(join(tmpdir(), 'jd-')), 'state.json');

test('fresh state when file missing', () => {
  const s = loadState(p);
  expect(s.cards).toEqual({});
  expect(s.celebrated).toEqual([]);
  expect(s.mergedTotal).toBe(0);
});

test('round-trips and creates card entries', () => {
  const s = loadState(p);
  cardState(s, 'PROJ-1').override = 'in_qa';
  saveState(p, s);
  const s2 = loadState(p);
  expect(s2.cards['PROJ-1'].override).toBe('in_qa');
});

import { test, expect } from 'vitest';
import { decideNotification, notificationText } from './notify.js';

const card = (key: string, summary = `summary for ${key}`) => ({ key, summary });
const on = { enabled: true, permission: 'granted', hidden: true };

test('the first snapshot only sets a baseline — a page load is not news', () => {
  const { fire, next } = decideNotification(undefined, [card('P-1'), card('P-2')], on);
  expect(fire).toEqual([]);
  expect(next).toEqual(['P-1', 'P-2']);
});

test('only cards that were not there last time fire', () => {
  const { fire, next } = decideNotification(['P-1'], [card('P-1'), card('P-2')], on);
  expect(fire.map(c => c.key)).toEqual(['P-2']);
  expect(next).toEqual(['P-1', 'P-2']);
});

test('an unchanged bucket fires nothing, however many times it is re-broadcast', () => {
  expect(decideNotification(['P-1'], [card('P-1')], on).fire).toEqual([]);
  expect(decideNotification(['P-1', 'P-2'], [card('P-2'), card('P-1')], on).fire).toEqual([]);
});

test('a swap that leaves the count unchanged still fires for the new card', () => {
  // The reason this is keyed on identity rather than length: ack one card and
  // another arrives in the same refresh, and a count comparison sees nothing.
  const { fire } = decideNotification(['P-1'], [card('P-2')], on);
  expect(fire.map(c => c.key)).toEqual(['P-2']);
});

test('a card that leaves and later returns fires again', () => {
  expect(decideNotification(['P-1'], [], on).fire).toEqual([]);
  expect(decideNotification([], [card('P-1')], on).fire.map(c => c.key)).toEqual(['P-1']);
});

test('nothing fires while the tab is visible, but the baseline still advances', () => {
  const { fire, next } = decideNotification(['P-1'], [card('P-1'), card('P-2')], { ...on, hidden: false });
  expect(fire).toEqual([]);
  // Critical: had this not advanced, P-2 would fire retroactively the moment
  // the user switched away, for a card they had already been looking at.
  expect(next).toEqual(['P-1', 'P-2']);
});

test('nothing fires when the toggle is off, and enabling it later does not flood', () => {
  const off = { ...on, enabled: false };
  const first = decideNotification(['P-1'], [card('P-1'), card('P-2'), card('P-3')], off);
  expect(first.fire).toEqual([]);
  // Baseline moved on while disabled, so turning it on starts from "now"
  // rather than announcing a backlog the user never asked about.
  expect(decideNotification(first.next, [card('P-1'), card('P-2'), card('P-3')], on).fire).toEqual([]);
});

test('nothing fires without granted permission', () => {
  for (const permission of ['default', 'denied']) {
    expect(decideNotification(['P-1'], [card('P-2')], { ...on, permission }).fire).toEqual([]);
  }
});

test('an emptied bucket is not an event', () => {
  const { fire, next } = decideNotification(['P-1', 'P-2'], [], on);
  expect(fire).toEqual([]);
  expect(next).toEqual([]);
});

test('copy names the card when there is one and counts them when there are several', () => {
  expect(notificationText([card('P-1', 'Fix login redirect')]))
    .toEqual({ title: 'P-1 needs attention', body: 'Fix login redirect' });
  expect(notificationText([card('P-1'), card('P-2')]))
    .toEqual({ title: '2 cards need attention', body: 'P-1, P-2' });
});

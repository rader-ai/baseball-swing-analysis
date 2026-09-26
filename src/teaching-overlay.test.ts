import test from 'node:test';
import assert from 'node:assert/strict';

import { attackCue, overlayPhases, buildTeachingOverlay } from './teaching-overlay.ts';
import { buildReport } from './swing-analysis.ts';

/* ------------------------------------------------------------------ attackCue */

test('attackCue: a slightly-up swing reads good', () => {
  const c = attackCue(10, 'full');
  assert.equal(c?.status, 'good');
});

test('attackCue: chopping down is flagged with a myth-free cue (match the pitch)', () => {
  const c = attackCue(-6, 'full');
  assert.equal(c?.status, 'work');
  assert.match(c!.cue.toLowerCase(), /match the pitch|slightly up|not.*down|chop/);
  assert.doesNotMatch(c!.cue.toLowerCase(), /swing down/); // never coach the myth
});

test('attackCue: a big uppercut is flagged', () => {
  const c = attackCue(30, 'full');
  assert.equal(c?.status, 'work');
});

test('attackCue: suppressed for young hitters (consistent with dropping rotation grading)', () => {
  assert.equal(attackCue(-10, 'young'), null);
  assert.equal(attackCue(35, 'young'), null);
});

/* --------------------------------------------------------------- overlayPhases */

test('overlayPhases anchors the teaching phases to the real contact frame', () => {
  const p = overlayPhases(10, 7);
  assert.deepEqual(p.map((x) => x.label), ['Setup', 'Load', 'Contact', 'Finish']);
  assert.equal(p.find((x) => x.label === 'Contact')?.idx, 7);
  assert.equal(p.find((x) => x.label === 'Setup')?.idx, 0);
  assert.equal(p.find((x) => x.label === 'Finish')?.idx, 9);
});

test('overlayPhases dedupes when contact is near the start', () => {
  const p = overlayPhases(10, 0);
  // Setup/Load/Contact collapse onto frame 0 → only distinct frames remain, monotonic
  const idxs = p.map((x) => x.idx);
  assert.deepEqual(idxs, [...idxs].sort((a, b) => a - b));
  assert.ok(p.some((x) => x.label === 'Finish'));
});

/* ----------------------------------------------------- buildTeachingOverlay */

test('buildTeachingOverlay surfaces the rubric’s top work-on cue + attack guidance + phases', () => {
  const report = buildReport({
    name: 'Kid', sport: 'baseball', ageMode: 'full',
    scores: { head: 90, posture: 88, balance: 85, stride: 42, sequence: 70, hands: 80 },
    stats: { stride: 'almost no stride' },
  });
  const o = buildTeachingOverlay({ report, attackDeg: 3, ageMode: 'full', nFrames: 10, contactIdx: 7 });
  assert.equal(o.topCue?.key, 'stride'); // the lowest-scoring 'work' metric
  assert.equal(o.topCue?.status, 'work');
  assert.ok(o.topCue?.cue.length, 'carries the drill cue');
  assert.equal(o.attack?.status, 'work'); // +3° is too flat
  assert.equal(o.phases.find((p) => p.label === 'Contact')?.idx, 7);
});

test('buildTeachingOverlay: an all-great swing has no top cue', () => {
  const report = buildReport({
    name: 'Kid', sport: 'baseball', ageMode: 'full',
    scores: { head: 90, posture: 88, balance: 85, stride: 85, sequence: 82, hands: 88 },
  });
  const o = buildTeachingOverlay({ report, attackDeg: 12, ageMode: 'full' });
  assert.equal(o.topCue, null);
  assert.equal(o.attack?.status, 'good');
  assert.deepEqual(o.phases, []); // no frames supplied
});

test('buildTeachingOverlay: young mode omits attack-angle coaching', () => {
  const report = buildReport({
    name: 'Lil', sport: 'baseball', ageMode: 'young',
    scores: { head: 90, balance: 60, posture: 88 },
  });
  const o = buildTeachingOverlay({ report, attackDeg: -10, ageMode: 'young' });
  assert.equal(o.attack, null);
});

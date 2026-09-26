import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ageModeForCohort, buildReport, gradeFor, overallGrade, sampleReport, GRADE_LABEL,
} from './swing-analysis.ts';

test('gradeFor maps scores to GREAT / GOOD / WORK', () => {
  assert.equal(gradeFor(90), 'great');
  assert.equal(gradeFor(78), 'great');
  assert.equal(gradeFor(60), 'good');
  assert.equal(gradeFor(42), 'work');
  assert.equal(GRADE_LABEL.work, 'WORK ON IT');
});

test('overallGrade is a TRUST-weighted mean — clean reads (head) outweigh estimates (stride)', () => {
  const headStrong = buildReport({ name: 'A', sport: 'baseball', ageMode: 'full', scores: { head: 100, posture: 50, balance: 50, stride: 50 } });
  const strideStrong = buildReport({ name: 'B', sport: 'baseball', ageMode: 'full', scores: { head: 50, posture: 50, balance: 50, stride: 100 } });
  assert.ok(headStrong.overallGrade > strideStrong.overallGrade, 'head (weight 30) drives the grade more than stride (weight 15)');
  assert.ok(headStrong.overallGrade > 0 && headStrong.overallGrade <= 100);
});

test('full mode grades the four reliable side-on metrics; great ones carry no drill, weak ones do', () => {
  const r = sampleReport('Sample Hitter', 'baseball', 'full');
  assert.equal(r.metrics.length, 4);
  assert.deepEqual(r.metrics.map((m) => m.key).sort(), ['balance', 'head', 'posture', 'stride']);
  const head = r.metrics.find((m) => m.key === 'head')!;
  const stride = r.metrics.find((m) => m.key === 'stride')!;
  assert.equal(head.grade, 'great');
  assert.equal(head.drill, undefined, 'a GREAT metric shows no drill');
  assert.equal(stride.grade, 'work');
  assert.ok(stride.drill, 'a WORK metric attaches a drill');
});

test('YOUNG mode drops rotation/sequence grading (no MLB scorecard on a 6-year-old)', () => {
  const r = buildReport({ name: 'Junior', sport: 'baseball', ageMode: 'young', scores: { head: 80, balance: 75 } });
  const keys = r.metrics.map((m) => m.key);
  assert.ok(!keys.includes('sequence'), 'young mode never grades hip-shoulder sequence');
  assert.ok(!keys.includes('stride'));
  assert.deepEqual(keys.sort(), ['balance', 'head', 'posture']);
  assert.match(r.headline, /keep/i); // encouragement-first
  assert.equal(ageModeForCohort('teeball'), 'young');
  assert.equal(ageModeForCohort('11-12'), 'full');
});

test('NEVER ships debunked cues — no "squish the bug", no "swing down"', () => {
  const r = sampleReport('Sample Hitter', 'baseball', 'full');
  const allText = JSON.stringify(r).toLowerCase();
  assert.ok(!allText.includes('squish'), 'squish-the-bug is a myth — must not appear');
  assert.ok(!/swing down|chop down/.test(allText), 'swing-down is a myth — must not appear');
  // the stride fix must cue the front leg, not the back foot
  const stride = r.metrics.find((m) => m.key === 'stride')!;
  assert.match(stride.drill!.how, /front leg/i);
});

test('honesty: rotation/sequence and hand-path are NEVER graded; head/balance are reliable 2D', () => {
  const r = sampleReport();
  assert.equal(r.metrics.find((m) => m.key === 'sequence'), undefined, 'sequence is never a graded row');
  assert.equal(r.metrics.find((m) => m.key === 'hands'), undefined, 'hand path is never a graded row');
  assert.equal(r.metrics.find((m) => m.key === 'head')!.reliable, true);
  assert.equal(r.metrics.find((m) => m.key === 'balance')!.reliable, true);
});

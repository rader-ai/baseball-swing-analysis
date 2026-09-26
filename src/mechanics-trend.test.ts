import test from 'node:test';
import assert from 'node:assert/strict';

import { mechanicsTrend, type SessionSignals } from './mechanics-trend.ts';

const sig = (headDriftPctBh: number, postureRangeDeg: number, balanceOffRatio: number) => ({
  headDriftPctBh,
  postureRangeDeg,
  balanceOffRatio,
  framesUsed: 12,
});

// n swings around the given values with a little swing-to-swing noise
const session = (date: string, head: number, posture: number, balance: number, n = 6): SessionSignals => ({
  date,
  swings: Array.from({ length: n }, (_, i) => sig(head + (i % 3) * 0.3, posture + (i % 3) * 0.4, balance + (i % 3) * 0.01)),
});

test('a real improvement across weeks is called improved, with the % in the line', () => {
  const t = mechanicsTrend([
    session('2026-06-12', 10, 9, 0.3),
    session('2026-06-19', 8, 8.8, 0.29),
    session('2026-07-03', 6, 8.6, 0.3),
  ]);
  assert.equal(t.ok, true);
  const head = t.reads.find((r) => r.key === 'head');
  assert.ok(head);
  assert.equal(head.verdict, 'improved');
  assert.match(head.line, /quieter/i);
  assert.match(head.line, /\d+%/);
  assert.match(t.headline, /quieter|progress/i);
});

test('noise-sized wobble is called steady, never regression-shamed', () => {
  const t = mechanicsTrend([
    session('2026-06-12', 8, 9, 0.3),
    session('2026-06-26', 8.4, 9.2, 0.31), // within the noise floor
  ]);
  assert.equal(t.ok, true);
  for (const r of t.reads) {
    assert.equal(r.verdict, 'steady', `${r.key} should be steady, got ${r.verdict}`);
    assert.doesNotMatch(r.line, /worse|bad|regressed/i);
  }
});

test('a clear backslide becomes a gentle watch, not a shame line', () => {
  const t = mechanicsTrend([
    session('2026-06-12', 5, 9, 0.3),
    session('2026-06-19', 5.2, 9.1, 0.3),
    session('2026-07-03', 11, 9, 0.3), // head got much busier
  ]);
  const head = t.reads.find((r) => r.key === 'head');
  assert.ok(head);
  assert.equal(head.verdict, 'watch');
  assert.doesNotMatch(head.line, /worse|bad|terrible/i);
});

test('honesty gates: one session, or too few swings, yields no trend', () => {
  assert.equal(mechanicsTrend([session('2026-06-12', 8, 9, 0.3)]).ok, false);
  assert.equal(
    mechanicsTrend([session('2026-06-12', 8, 9, 0.3, 2), session('2026-06-26', 6, 9, 0.3, 2)]).ok,
    false,
  );
});

test('voice rails: no em or en dashes, PR never PB, anywhere in the copy', () => {
  const t = mechanicsTrend([
    session('2026-06-12', 10, 12, 0.4),
    session('2026-07-03', 5, 8, 0.2),
  ]);
  const all = [t.headline, ...t.reads.map((r) => r.line)].join(' ');
  assert.doesNotMatch(all, /—|–/);
  assert.doesNotMatch(all, /\bPB\b/);
});

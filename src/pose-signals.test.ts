import test from 'node:test';
import assert from 'node:assert/strict';

import { keepStableSubject, swingSignals } from './pose-signals.ts';
import type { PoseFrame } from './pose-metrics.ts';

// Minimal skeleton at (x, y): enough joints for body height, window, and all reads.
function body(t: number, x: number, opts: { headDx?: number; neckDx?: number; wristX?: number } = {}): PoseFrame {
  const c = 0.9;
  const wx = opts.wristX ?? x + 0.05;
  return {
    t,
    head: { x: x + (opts.headDx ?? 0), y: 0.86, c },
    neck: { x: x + (opts.neckDx ?? 0), y: 0.76, c },
    root: { x, y: 0.5, c },
    footL: { x: x - 0.05, y: 0.06, c },
    footR: { x: x + 0.05, y: 0.06, c },
    wristL: { x: wx, y: 0.6, c },
    wristR: { x: wx + 0.01, y: 0.6, c },
  };
}

/** A synthetic swing: quiet approach, hands accelerate to a peak, then settle. */
function swing(headDrift = 0): PoseFrame[] {
  const frames: PoseFrame[] = [];
  for (let i = 0; i < 24; i++) {
    // hand speed ramps into "contact" at i=14 then slows
    const wristX = 0.4 + (i < 14 ? 0.004 * i : 0.06 + 0.02 * (i - 14));
    // head drifts forward linearly through the swing when headDrift > 0
    const headDx = headDrift * (i / 23);
    frames.push(body(i / 10, 0.5, { wristX, headDx }));
  }
  return frames;
}

test('swingSignals: a quiet swing reads near-zero drift; a drifting head reads bigger', () => {
  const quiet = swingSignals(swing(0));
  // 15% of frame width of forward drift; the swing window sees a chunk of it
  const drifty = swingSignals(swing(0.15));
  assert.ok(quiet && drifty);
  assert.ok(quiet.headDriftPctBh < 2, `quiet drift ${quiet.headDriftPctBh}`);
  assert.ok(drifty.headDriftPctBh > quiet.headDriftPctBh + 3, `drifty ${drifty.headDriftPctBh} vs quiet ${quiet.headDriftPctBh}`);
});

test('swingSignals: returns null when the pose stream is too thin to read', () => {
  assert.equal(swingSignals([body(0, 0.5)]), null);
});

test('keepStableSubject drops wrong-body frames before signals are computed', () => {
  const batter = swing(0);
  const intruder = Array.from({ length: 5 }, (_, i) => body(100 + i, 0.12));
  const kept = keepStableSubject([...batter.slice(0, 12), ...intruder, ...batter.slice(12)]);
  assert.equal(kept.length, batter.length);
  for (const f of kept) assert.ok(Math.abs((f.root?.x ?? 0) - 0.5) < 0.1);
});

import test from 'node:test';
import assert from 'node:assert/strict';

import { segmentSwing, speedSeries } from './swing-phases.ts';

// A swing's motion profile: still "set" → ramp (load/swing) → PEAK at contact → decay (follow-through)
function profile(): number[] {
  const m: number[] = [];
  for (let i = 0; i < 12; i++) m.push(1); // 0–11 pre-load / set (body still)
  for (let i = 2; i <= 10; i++) m.push(i); // 12–20 ramp to the peak; contact at 20 (=10)
  for (let i = 9; i >= 1; i--) m.push(i); // 21–29 follow-through decay
  m.push(1); // 30
  return m;
}

test('anchors at contact and finds swing (backward) + follow-through (forward) from motion', () => {
  const s = segmentSwing({ motion: profile(), contactIdx: 20 });
  assert.equal(s.contactIdx, 20);
  assert.equal(s.swing.end, 20); // the swing ends at contact
  assert.equal(s.swing.start, 13); // motion crossed 30% of peak (=3) at frame 13 going back
  assert.deepEqual(s.preLoad, { start: 0, end: 13 }); // everything before the swing is the set/pre-load
  assert.equal(s.followThrough.start, 20);
  assert.equal(s.followThrough.end, 28); // decays below 30% of peak at 28
});

test('key frames are ordered set < launch < contact < follow and sit in their phases', () => {
  const s = segmentSwing({ motion: profile(), contactIdx: 20 });
  const { set, launch, contact, follow } = s.keyFrames;
  assert.ok(set < launch && launch < contact && contact < follow, `${set} ${launch} ${contact} ${follow}`);
  assert.equal(launch, s.swing.start); // launch = where the swing fires
  assert.equal(contact, 20);
  assert.ok(set >= s.preLoad.start && set < s.preLoad.end, 'set sits in pre-load');
  assert.ok(follow > s.followThrough.start && follow <= s.followThrough.end, 'follow sits in follow-through');
});

test('contact near the start still yields a valid, monotonic segmentation', () => {
  const s = segmentSwing({ motion: profile(), contactIdx: 2 });
  assert.ok(s.preLoad.start <= s.preLoad.end);
  assert.ok(s.swing.start <= s.swing.end && s.swing.end === 2);
  assert.ok(s.followThrough.start === 2 && s.followThrough.end >= 2);
  const { set, launch, contact, follow } = s.keyFrames;
  assert.ok(set <= launch && launch <= contact && contact <= follow);
});

test('a flat clip (no clear swing) falls back to a small window around contact', () => {
  const flat = new Array(30).fill(5);
  const s = segmentSwing({ motion: flat, contactIdx: 15, minSwingFrames: 3 });
  assert.ok(s.swing.end - s.swing.start >= 3, 'swing window is at least the minimum');
  assert.ok(s.followThrough.end > s.followThrough.start);
});

test('speedSeries gives per-frame motion magnitude from a tracked point', () => {
  const pts = [{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 3, y: 4 }, { x: 6, y: 8 }];
  const sp = speedSeries(pts);
  assert.equal(sp.length, pts.length); // aligned to frames (first = 0)
  assert.equal(sp[0], 0);
  assert.equal(sp[1], 5); // (3,4) = 5
  assert.equal(sp[2], 0);
  assert.equal(sp[3], 5);
});

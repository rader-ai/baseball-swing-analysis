import test from 'node:test';
import assert from 'node:assert/strict';

import { swingMetrics, frameFromVision, reportFromFrames, reportFromPoseFrames, type PoseFrame, type Pt } from './pose-metrics.ts';
import { buildReport } from './swing-analysis.ts';

const P = (x: number, y: number): Pt => ({ x, y, c: 0.9 });
// a plausible side-on stance (y-UP, Vision convention); head position is the variable
function frame(t: number, head: [number, number], o: Partial<PoseFrame> = {}): PoseFrame {
  return {
    t, head: P(head[0], head[1]),
    neck: o.neck ?? P(0.5, 0.62), root: o.root ?? P(0.5, 0.45),
    footL: o.footL ?? P(0.45, 0.1), footR: o.footR ?? P(0.55, 0.1),
  };
}

test('quiet head grades GREAT; a drifting head grades WORK', () => {
  const still = [0, 1, 2, 3].map((i) => frame(i, [0.5, 0.72]));
  assert.ok((swingMetrics(still).scores.head ?? 0) >= 78, 'still head should be great');
  const drift = [[0.40, 0.72], [0.50, 0.72], [0.62, 0.72], [0.70, 0.72]].map((h, i) => frame(i, h as [number, number]));
  assert.ok((swingMetrics(drift).scores.head ?? 100) < 58, 'big drift should grade work');
});

test('posture: staying down grades higher than standing up', () => {
  const down = [0.72, 0.72, 0.72, 0.72].map((hy, i) => frame(i, [0.5, hy]));
  const up = [0.72, 0.77, 0.83, 0.88].map((hy, i) => frame(i, [0.5, hy]));
  const d = swingMetrics(down).scores.posture ?? 0;
  const u = swingMetrics(up).scores.posture ?? 100;
  assert.ok(d > u, `stays-down (${d}) should beat stands-up (${u})`);
  assert.ok(d >= 78);
});

test('balance: centered over the base grades higher than leaning out', () => {
  const centered = [0, 1, 2, 3].map((i) => frame(i, [0.5, 0.72]));
  const leaning = [0, 1, 2, 3].map((i) => frame(i, [0.5, 0.72], { root: P(0.58, 0.45) }));
  assert.ok((swingMetrics(centered).scores.balance ?? 0) > (swingMetrics(leaning).scores.balance ?? 100));
});

test('only the reliable in-plane reads are scored (no faked rotation/hands)', () => {
  const r = swingMetrics([0, 1, 2, 3].map((i) => frame(i, [0.5, 0.72])));
  assert.equal(r.scores.sequence, undefined, 'sequence is a 2D estimate — left undefined');
  assert.equal(r.scores.hands, undefined, 'hand path is a 2D estimate — left undefined');
  assert.ok(r.scores.head !== undefined && r.scores.posture !== undefined && r.scores.balance !== undefined);
});

test('frameFromVision maps the Apple Vision joint names', () => {
  const f = frameFromVision({ head_joint: [0.5, 0.7, 0.9], left_foot_joint: [0.45, 0.1, 0.8], root: [0.5, 0.45, 0.9] }, 1);
  assert.equal(f.head?.x, 0.5);
  assert.equal(f.footL?.y, 0.1);
  assert.equal(f.root?.c, 0.9);
  assert.equal(f.shoulderL, undefined);
});

// build a 3D frame: hips/shoulders as horizontal lines rotated by the given angle
// in the x–z plane, so lineAngle(L,R) == that angle.
function frame3D(t: number, hipDeg: number, shDeg: number): PoseFrame {
  const rad = (a: number) => (a * Math.PI) / 180;
  const line = (deg: number, y: number) => ({
    L: { x: 0.5 - 0.1 * Math.cos(rad(deg)), y, z: -0.1 * Math.sin(rad(deg)), c: 0.9 },
    R: { x: 0.5 + 0.1 * Math.cos(rad(deg)), y, z: 0.1 * Math.sin(rad(deg)), c: 0.9 },
  });
  const h = line(hipDeg, 0.45);
  const s = line(shDeg, 0.62);
  return {
    t, head: P(0.5, 0.72), root: P(0.5, 0.45), footL: P(0.45, 0.1), footR: P(0.55, 0.1),
    hipL: h.L, hipR: h.R, shoulderL: s.L, shoulderR: s.R,
  };
}

test('3D depth present, but sequence is STILL walled off (never graded side-on)', () => {
  // Even when z is available (monocular 3D lift), hip-shoulder separation / kinematic
  // sequence is a transverse-plane rotation we do NOT grade — it is unvalidated and
  // foreshortens side-on (docs/research/24 §3.5). It must never appear as a score.
  const hip = [0, 20, 40, 40, 40];
  const sho = [0, 0, 5, 25, 40];
  const r = swingMetrics(hip.map((h, i) => frame3D(i, h, sho[i])));
  assert.equal(r.scores.sequence, undefined, 'sequence is never scored');
  assert.equal(r.reliable.sequence, undefined, 'sequence is never marked reliable');
});

test('2D (no depth) leaves sequence unmeasured + not reliable', () => {
  const r = swingMetrics([0, 1, 2, 3].map((i) => frame(i, [0.5, 0.72])));
  assert.equal(r.scores.sequence, undefined);
  assert.equal(r.reliable.sequence, undefined);
});

test('reportFromPoseFrames turns raw Vision frames into a graded report', () => {
  const J = (): Record<string, [number, number, number]> => ({
    head_joint: [0.5, 0.72, 0.9], neck_1_joint: [0.5, 0.62, 0.9], root: [0.5, 0.45, 0.9],
    left_foot_joint: [0.45, 0.1, 0.9], right_foot_joint: [0.55, 0.1, 0.9],
  });
  const frames = [0, 1, 2, 3].map((i) => ({ t: i, joints: J() }));
  const r = reportFromPoseFrames(frames, { name: 'Kid', sport: 'baseball', ageMode: 'full' });
  assert.equal(r.name, 'Kid');
  assert.ok(r.metrics.length >= 3);
  assert.equal(r.metrics.find((m) => m.key === 'head')?.grade, 'great');
});

test('swingMetrics drives a real young-mode buildReport', () => {
  const { scores } = swingMetrics([0, 1, 2, 3].map((i) => frame(i, [0.5, 0.72])));
  const r = buildReport({ name: 'Test', sport: 'baseball', ageMode: 'young', scores });
  assert.equal(r.metrics.length, 3, 'young mode grades head/balance/posture only');
  assert.equal(r.metrics.find((m) => m.key === 'head')?.grade, 'great');
});

// ----- contact anchoring (Phase 2): a crack pins the real Contact frame -----

// 10 identifiable frames — head.x encodes the frame index so we can tell which
// frame a pose came from. Enough joints (≥4) that keyPhases keeps every phase.
function idFrames(): PoseFrame[] {
  return Array.from({ length: 10 }, (_, i) => ({
    t: i * 0.01,
    head: { x: i / 100, y: 0.9, c: 0.9 },
    neck: P(0.5, 0.62), root: P(0.5, 0.45),
    shoulderL: P(0.44, 0.82), shoulderR: P(0.56, 0.82),
    footL: P(0.45, 0.1), footR: P(0.55, 0.1),
  }));
}

test('reportFromFrames anchors the Contact pose to the crack frame', () => {
  const frames = idFrames();
  const r = reportFromFrames(
    frames,
    { name: 'K', sport: 'baseball', ageMode: 'full' },
    { t: 0.071, quality: 0.8, peakHz: 2400, hfLfRatio: 4 }, // crack → frame 7
  );
  const contact = r.poses?.find((p) => p.label === 'Contact');
  assert.ok(contact, 'a Contact phase is present');
  assert.ok(Math.abs(contact!.joints.head[0] - 7 / 100) < 1e-9, 'Contact pose came from frame 7, not the evenly-spaced frame 6');
  assert.equal(r.contactQuality?.bucket, 'flush');
  assert.equal(r.contactQuality?.calibrated, false);
});

test('reportFromFrames without a crack keeps the evenly-spaced poses (no regression)', () => {
  const frames = idFrames();
  const r = reportFromFrames(frames, { name: 'K', sport: 'baseball', ageMode: 'full' });
  const contact = r.poses?.find((p) => p.label === 'Contact');
  assert.ok(Math.abs(contact!.joints.head[0] - 6 / 100) < 1e-9, 'unchanged: Contact is the evenly-spaced frame 6');
  assert.equal(r.contactQuality, undefined, 'no crack → no quality chip');
});

test('reportFromFrames windows the grade to the swing — pre-swing walk-up does not tank head stillness', () => {
  // 14 frames: head WANDERS during the walk-up (0–3), then is STILL through the swing (4–13).
  // Hands are still until ~frame 7, then accelerate to a peak ~frame 10 (≈ contact).
  const handX = (i: number) => (i <= 6 ? 0.6 : [0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.65, 0.72, 0.81, 0.92, 0.97, 0.99, 1.0][i]);
  const frames: PoseFrame[] = Array.from({ length: 14 }, (_, i) => ({
    t: i * 0.01,
    head: P(i <= 3 ? 0.5 + (i % 2 ? 0.12 : -0.12) : 0.5, 0.72), // wander early, dead still during the swing
    neck: P(0.5, 0.62), root: P(0.5, 0.45),
    shoulderL: P(0.44, 0.82), shoulderR: P(0.56, 0.82),
    footL: P(0.45, 0.1), footR: P(0.55, 0.1),
    wristL: P(handX(i), 0.7), wristR: P(handX(i) + 0.02, 0.7),
  }));
  const windowedHead = reportFromFrames(frames, { name: 'K', sport: 'baseball', ageMode: 'full' }).metrics.find((m) => m.key === 'head')!.score;
  const wholeClipHead = swingMetrics(frames).scores.head ?? 0;
  assert.ok(windowedHead > wholeClipHead, `windowed head ${windowedHead} should beat whole-clip ${wholeClipHead}`);
  assert.ok(windowedHead >= 78, `head graded great when still through the swing, got ${windowedHead}`);
});

test('reportFromPoseFrames threads a native contact through to the report', () => {
  const J = (i: number): Record<string, number[]> => ({
    head_joint: [i / 100, 0.72, 0.9], neck_1_joint: [0.5, 0.62, 0.9], root: [0.5, 0.45, 0.9],
    left_foot_joint: [0.45, 0.1, 0.9], right_foot_joint: [0.55, 0.1, 0.9],
  });
  const frames = Array.from({ length: 10 }, (_, i) => ({ t: i * 0.01, joints: J(i) }));
  const r = reportFromPoseFrames(
    frames,
    { name: 'Kid', sport: 'baseball', ageMode: 'full' },
    { t: 0.031, quality: 0.2, peakHz: 600, hfLfRatio: 0.5 }, // crack → frame 3, a mishit
  );
  const contact = r.poses?.find((p) => p.label === 'Contact');
  assert.ok(Math.abs(contact!.joints.head[0] - 3 / 100) < 1e-9, 'Contact anchored to frame 3');
  assert.equal(r.contactQuality?.bucket, 'mishit');
});

test('no body scale (head + feet never both seen) → no in-plane grades, flagged unreliable — never a %-of-frame grade', () => {
  // half-body clip: head, neck, root visible, feet never in frame
  const frames: PoseFrame[] = [0, 1, 2, 3, 4].map((i) => ({ t: i, head: P(0.5 + 0.02 * i, 0.72), neck: P(0.5, 0.62), root: P(0.5, 0.45) }));
  const r = swingMetrics(frames);
  assert.equal(r.scores.head, undefined);
  assert.equal(r.scores.posture, undefined);
  assert.equal(r.scores.balance, undefined);
  assert.equal(r.reliable.head, false);
  assert.equal(r.reliable.posture, false);
  assert.equal(r.reliable.balance, false);
});

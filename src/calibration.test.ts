import { test } from 'node:test';
import assert from 'node:assert/strict';
import { swingMetrics, DEFAULT_CALIBRATION, type Calibration } from './pose-metrics.ts';
import type { PoseFrame } from './pose-metrics.ts';

// Frames with a head that drifts relative to the body → a gradeable head score < 100.
// y-UP convention (Apple Vision): head is at HIGHER y than feet.
function driftFrames(): PoseFrame[] {
  const p = (x: number, y: number) => ({ x, y, c: 0.9 });
  const out: PoseFrame[] = [];
  for (let i = 0; i < 16; i++) {
    const d = (i / 15) * 0.20; // head walks away from root over the swing (widened for measurable drift)
    out.push({
      t: i / 15,
      head: p(0.5 + d, 0.95), neck: p(0.5, 0.75), root: p(0.5, 0.45),
      shoulderL: p(0.45, 0.72), shoulderR: p(0.55, 0.72),
      hipL: p(0.46, 0.45), hipR: p(0.54, 0.45),
      kneeL: p(0.46, 0.28), kneeR: p(0.54, 0.28),
      footL: p(0.46, 0.05), footR: p(0.54, 0.05),
      wristL: p(0.4, 0.6), wristR: p(0.42, 0.6),
    } as PoseFrame);
  }
  return out;
}

test('omitting cal equals passing DEFAULT_CALIBRATION (app default path frozen)', () => {
  const f = driftFrames();
  assert.deepEqual(swingMetrics(f), swingMetrics(f, DEFAULT_CALIBRATION));
});

test('a stricter head calibration lowers the head score (the dial is wired through)', () => {
  const f = driftFrames();
  const base = swingMetrics(f).scores.head;
  assert.ok(base != null, 'fixture must produce a head score');
  const strict: Calibration = { ...DEFAULT_CALIBRATION, head: { free: 0, slope: 25 } };
  const tuned = swingMetrics(f, strict).scores.head!;
  assert.ok(tuned < base!, `strict head cal should lower the score (base ${base}, tuned ${tuned})`);
});

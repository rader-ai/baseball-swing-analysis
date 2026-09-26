import test from 'node:test';
import assert from 'node:assert/strict';

import {
  nearestFrameIdx,
  anchorContact,
  phaseIndicesFromContact,
  readContactQuality,
  attributeSwing,
  pickContactCrack,
  CrackFuser,
} from './contact-sync.ts';

/** A uniform timeline of `n` frames at spacing `dt`, starting at `t0`. */
const grid = (n: number, dt = 0.01, t0 = 0) => Array.from({ length: n }, (_, i) => ({ t: t0 + i * dt }));

/* ------------------------------------------------------------ nearestFrameIdx */

test('nearestFrameIdx picks the frame closest in time', () => {
  const frames = [{ t: 0 }, { t: 0.1 }, { t: 0.2 }, { t: 0.3 }];
  assert.equal(nearestFrameIdx(0.18, frames), 2);
  assert.equal(nearestFrameIdx(0.04, frames), 0);
  assert.equal(nearestFrameIdx(0.26, frames), 3); // 0.26→0.30 (0.04) beats →0.20 (0.06)
});

test('nearestFrameIdx returns -1 for empty input', () => {
  assert.equal(nearestFrameIdx(1, []), -1);
});

/* -------------------------------------------------------------- anchorContact */

test('anchorContact: a crack picks the real contact frame (high confidence)', () => {
  const frames = grid(21); // t = 0 .. 0.20 @ 0.01
  const a = anchorContact({ crack: { t: 0.123 }, frames, cameraDistanceFt: 0 });
  assert.equal(a.source, 'audio');
  assert.equal(a.contactIdx, 12); // t=0.12 is nearest 0.123
  assert.ok(Math.abs(a.contactTimeS - 0.123) < 1e-9);
  assert.equal(a.confidence, 'high');
});

test('anchorContact: subtracts the sound-travel delay (the mic hears it late)', () => {
  const frames = grid(21);
  const dist = 11.25; // 11.25 ft / 1125 ft·s⁻¹ = 0.01 s exactly
  const a = anchorContact({ crack: { t: 0.13 }, frames, cameraDistanceFt: dist });
  assert.ok(Math.abs(a.contactTimeS - 0.12) < 1e-9, 'contact is 10 ms before the mic heard it');
  assert.equal(a.contactIdx, 12);
});

test('anchorContact: no crack falls back to the evenly-spaced heuristic, low confidence', () => {
  const frames = grid(21);
  const a = anchorContact({ frames, cameraDistanceFt: 5 });
  assert.equal(a.source, 'fallback');
  assert.equal(a.confidence, 'low');
  assert.equal(a.contactIdx, 12); // default frac 0.6 → round(0.6 * 20)
});

test('anchorContact: a crack near the edge of capture is only medium confidence', () => {
  const frames = grid(21); // span 0 .. 0.20, spacing 0.01
  const a = anchorContact({ crack: { t: 0.005 }, frames, cameraDistanceFt: 0 });
  assert.equal(a.source, 'audio');
  assert.equal(a.confidence, 'medium'); // inside the span but within one frame of the start
});

test('anchorContact: a crack outside the captured frames is low confidence', () => {
  const frames = grid(21); // span 0 .. 0.20
  const a = anchorContact({ crack: { t: 0.5 }, frames, cameraDistanceFt: 0 });
  assert.equal(a.source, 'audio');
  assert.equal(a.contactIdx, 20); // clamps to the nearest (last) frame
  assert.equal(a.confidence, 'low');
});

test('anchorContact: empty frames → contactIdx -1, low confidence', () => {
  const a = anchorContact({ crack: { t: 0.1 }, frames: [], cameraDistanceFt: 0 });
  assert.equal(a.contactIdx, -1);
  assert.equal(a.confidence, 'low');
});

/* ------------------------------------------------------ phaseIndicesFromContact */

test('phaseIndicesFromContact anchors Contact to the real frame, Load between', () => {
  assert.deepEqual(phaseIndicesFromContact(20, 12), { setup: 0, load: 6, contact: 12, finish: 19 });
});

test('phaseIndicesFromContact stays in-range and monotonic near the start', () => {
  const p = phaseIndicesFromContact(20, 1);
  assert.equal(p.setup, 0);
  assert.equal(p.contact, 1);
  assert.equal(p.finish, 19);
  assert.ok(p.setup <= p.load && p.load <= p.contact, 'monotonic non-decreasing');
});

test('phaseIndicesFromContact clamps an out-of-range contact index', () => {
  const p = phaseIndicesFromContact(10, 99);
  assert.equal(p.contact, 9);
  assert.equal(p.finish, 9);
  assert.ok(p.setup <= p.load && p.load <= p.contact && p.contact <= p.finish);
});

/* -------------------------------------------------------- readContactQuality */

test('readContactQuality buckets a bright crack as flush — but never calibrated', () => {
  const q = readContactQuality({ quality: 0.9, peakHz: 2600, hfLfRatio: 5 });
  assert.equal(q.bucket, 'flush');
  assert.equal(q.calibrated, false);
  assert.match(q.basis, /2600/); // basis cites the acoustic evidence
});

test('readContactQuality buckets a dull thunk as a mishit', () => {
  const q = readContactQuality({ quality: 0.1, peakHz: 520, hfLfRatio: 0.4 });
  assert.equal(q.bucket, 'mishit');
});

test('readContactQuality with no crack is unknown', () => {
  const q = readContactQuality(undefined);
  assert.equal(q.bucket, 'unknown');
  assert.equal(q.calibrated, false);
});

test('readContactQuality is NEVER presented as calibrated (honesty bar)', () => {
  for (const s of [0, 0.3, 0.5, 0.7, 1]) {
    assert.equal(readContactQuality({ quality: s, peakHz: 1500, hfLfRatio: 2 }).calibrated, false);
  }
});

/* -------------------------------------------------------------- attributeSwing */

test('attributeSwing confirms when a crack and a ball flight coincide', () => {
  const flight = grid(8, 0.004, 0.2); // 8 frames @ 240 fps starting at 0.20 s
  const r = attributeSwing({ crack: { t: 0.205 }, flightFrames: flight, matchWindowS: 0.02, cameraDistanceFt: 0 });
  assert.equal(r.verdict, 'confirmed');
  assert.equal(r.matched, true);
});

test("attributeSwing flags a crack with no nearby ball as someone else's hit", () => {
  const flight = grid(8, 0.004, 1.0); // flight a full second away
  const r = attributeSwing({ crack: { t: 0.205 }, flightFrames: flight, matchWindowS: 0.02, cameraDistanceFt: 0 });
  assert.equal(r.verdict, 'crack-no-ball');
  assert.equal(r.matched, false);
});

test('attributeSwing flags ball flight with no crack (vision-only → degrade confidence)', () => {
  const flight = grid(8, 0.004, 0.2);
  const r = attributeSwing({ flightFrames: flight, matchWindowS: 0.02, cameraDistanceFt: 0 });
  assert.equal(r.verdict, 'ball-no-crack');
});

/* ------------------------------------------------------------------ CrackFuser */

test('CrackFuser tags a swing whose flight matches a noted crack as flush + confirmed', () => {
  const f = new CrackFuser({ cameraDistanceFt: 5 });
  f.noteCrack({ t: 0.205, quality: 0.85, peakHz: 2500, hfLfRatio: 5 });
  const flight = grid(8, 0.004, 0.2); // 240 fps flight beginning at the contact
  const { quality, attribution } = f.fuse(flight);
  assert.equal(quality.bucket, 'flush');
  assert.equal(attribution.verdict, 'confirmed');
});

/* ----------------------------------------------------------- pickContactCrack */
// Driven by real footage (docs/research/20): the LOUDEST crack is usually the ball
// hitting the net frame ~100 ms after contact; a soft-ball contact is the quietest.
// So loudness can't pick contact — fuse with the ball-flight onset when we have it.

test('pickContactCrack: with ball flight, picks the contact crack — NOT the louder net-frame ping', () => {
  const cracks = [
    { t: 1.09, quality: 0.4, peakHz: 1600, hfLfRatio: 2 }, // bat-ball contact (dull-ish)
    { t: 1.2, quality: 0.9, peakHz: 4400, hfLfRatio: 6 }, // ball hits the metal net frame (louder)
  ];
  const pick = pickContactCrack(cracks, { ballFlightStartT: 1.086, cameraDistanceFt: 5 });
  assert.equal(pick?.t, 1.09);
});

test('pickContactCrack: audio-only falls back to the EARLIEST crack (contact precedes the net ping)', () => {
  const cracks = [
    { t: 1.2, quality: 0.9, peakHz: 4400, hfLfRatio: 6 },
    { t: 1.09, quality: 0.4, peakHz: 1600, hfLfRatio: 2 },
  ];
  assert.equal(pickContactCrack(cracks, { cameraDistanceFt: 5 })?.t, 1.09);
});

test('pickContactCrack: no cracks → undefined', () => {
  assert.equal(pickContactCrack([], { cameraDistanceFt: 5 }), undefined);
});

test('CrackFuser consumes the crack — a later swing with no new crack is unknown', () => {
  const f = new CrackFuser({ cameraDistanceFt: 0 });
  f.noteCrack({ t: 0.205, quality: 0.85, peakHz: 2500, hfLfRatio: 5 });
  f.fuse(grid(8, 0.004, 0.2)); // consumes the crack
  const { quality, attribution } = f.fuse(grid(8, 0.004, 0.5));
  assert.equal(quality.bucket, 'unknown');
  assert.equal(attribution.verdict, 'ball-no-crack');
});

/**
 * swing-phases.ts — segment a swing into its three coaching phases, ANCHORED at the
 * audible contact (the bat-crack frame). PURE + node-testable.
 *
 * The model: contact is one measured point; from it we look BACKWARD for the
 * swing (the move to contact) and the pre-load/SET before it, and FORWARD for the
 * follow-through. The boundaries come from MOTION, not fixed time offsets — every hitter
 * loads and fires at a different tempo:
 *
 *   pre-load / SET   the body is set, getting ready — low motion, before the swing
 *   swing            the move to contact — motion ramps to its peak AT contact
 *   follow-through   after contact — motion decays as the swing finishes
 *
 * Feeds (a) the analysis WINDOW — score head/posture/balance over the swing, not the whole
 * clip (whole-clip scoring tanks the grade with walk-up/settle, docs/research/23), and
 * (b) the teaching carousel (Set → Launch → Contact → Follow-through, on real frames).
 *
 * `motion` is a per-frame magnitude (e.g. hand/wrist speed via `speedSeries`); `contactIdx`
 * comes from the audio crack (contact-sync). Capture-agnostic — any motion signal works.
 */

export type PhaseRange = { start: number; end: number };

export type SwingSegmentation = {
  contactIdx: number;
  preLoad: PhaseRange; // [0, swingStart) — the set / getting-ready
  swing: PhaseRange; // [swingStart, contact] — the move to contact
  followThrough: PhaseRange; // [contact, settle] — finishing the swing
  // representative frames for the 4-point carousel (Set → Launch → Contact → Follow-through)
  keyFrames: { set: number; launch: number; contact: number; follow: number };
};

export type SegmentOpts = {
  motion: number[]; // per-frame motion magnitude (hand speed, bat-tip speed, …)
  contactIdx: number; // the contact frame (from the audio crack)
  swingMotionFrac?: number; // swing = the run into contact above this × peak (default 0.3)
  settleFrac?: number; // follow-through ends when motion falls below this × peak (default 0.3)
  minSwingFrames?: number; // floor on the swing window length (default 3)
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function segmentSwing(opts: SegmentOpts): SwingSegmentation {
  const { motion } = opts;
  const n = motion.length;
  const swingFrac = opts.swingMotionFrac ?? 0.3;
  const settleFrac = opts.settleFrac ?? 0.3;
  const minSwing = opts.minSwingFrames ?? 3;
  const ci = clamp(opts.contactIdx, 0, Math.max(0, n - 1));

  if (n === 0) return { contactIdx: 0, preLoad: { start: 0, end: 0 }, swing: { start: 0, end: 0 }, followThrough: { start: 0, end: 0 }, keyFrames: { set: 0, launch: 0, contact: 0, follow: 0 } };

  // peak motion over the run up to contact (the swing accelerates to its peak at contact)
  let peak = 0;
  for (let i = 0; i <= ci; i++) if (motion[i] > peak) peak = motion[i];
  peak = Math.max(peak, 1e-9);
  const swingThresh = swingFrac * peak;
  const settleThresh = settleFrac * peak;

  // SWING: walk back from contact while motion stays high — that contiguous run IS the swing
  let swingStart = ci;
  while (swingStart - 1 >= 0 && motion[swingStart - 1] >= swingThresh) swingStart--;
  if (ci - swingStart < minSwing) swingStart = Math.max(0, ci - minSwing); // floor

  // FOLLOW-THROUGH: walk forward from contact while motion stays high; settle at the first drop
  let j = ci;
  while (j + 1 <= n - 1 && motion[j + 1] >= settleThresh) j++;
  const settle = clamp(j + 1, ci, n - 1);

  const preLoad = { start: 0, end: swingStart };
  const swing = { start: swingStart, end: ci };
  const followThrough = { start: ci, end: settle };

  // representative carousel frames
  const set = clamp(Math.floor((preLoad.start + preLoad.end) / 2), preLoad.start, Math.max(preLoad.start, preLoad.end - 1));
  const follow = clamp(Math.round((followThrough.start + followThrough.end) / 2), followThrough.start, followThrough.end);
  return { contactIdx: ci, preLoad, swing, followThrough, keyFrames: { set, launch: swingStart, contact: ci, follow } };
}

/** Per-frame motion magnitude of a tracked point (hands/wrist/bat-tip). First frame = 0. */
export function speedSeries(pts: { x: number; y: number }[]): number[] {
  const out = new Array(pts.length).fill(0);
  for (let i = 1; i < pts.length; i++) out[i] = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return out;
}

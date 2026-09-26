/**
 * pose-metrics.ts — turn a sequence of body-pose frames into swing MetricScores
 * (the real brain behind Review). PURE + node-testable; ZERO capture/RN imports.
 *
 * CAPTURE-AGNOSTIC by design: it takes a normalized skeleton per frame, so the
 * SAME engine grades whichever source produced the pose —
 *   - 2D Apple Vision (VNDetectHumanBodyPose) over recorded or uploaded video, or
 *   - 3D ARKit body tracking (ARSkeleton3D) on a device (LiDAR-sharpened).
 * The capture layer maps its joint names into PoseFrame (see frameFromVision);
 * a future 3D mapper fills `z` and the same metrics get a depth-aware upgrade.
 *
 * HONESTY: we only SCORE what a phone reads reliably in-plane — head stillness,
 * posture/spine, balance/base, and stride. Rotation/sequence + fine hand path are
 * 2D estimates, so we leave them undefined here and let swing-analysis default
 * them (and AGE MODE drops rotation grading for the youngest hitters entirely).
 *
 * Coordinates: normalized [0,1], y-UP (Apple Vision convention). A 3D mapper
 * should pass the same in-plane x/y (and add z) so these reads are unchanged.
 */
import { nearestFrameIdx, phaseIndicesFromContact, readContactQuality, type CrackContact } from './contact-sync.ts';
import { swingSignals } from './pose-signals.ts';
import { segmentSwing, speedSeries } from './swing-phases.ts';
import { buildReport, type AgeMode, type MetricKey, type MetricScores, type PosePhase, type SwingReport } from './swing-analysis.ts';
import type { Sport } from './engine-types.ts';

export type { CrackContact };

export type Pt = { x: number; y: number; z?: number; c: number };
export type PoseFrame = {
  t: number;
  head?: Pt; chin?: Pt; eyeL?: Pt; eyeR?: Pt; neck?: Pt;
  shoulderL?: Pt; shoulderR?: Pt;
  elbowL?: Pt; elbowR?: Pt;
  hipL?: Pt; hipR?: Pt; root?: Pt;
  kneeL?: Pt; kneeR?: Pt;
  footL?: Pt; footR?: Pt;
  wristL?: Pt; wristR?: Pt;
};

export type SwingRead = {
  scores: MetricScores;
  stats: Partial<Record<MetricKey, string>>;
  // which reads were measured RELIABLY (vs the library default). 3D capture flips
  // `sequence` true — horizontal-plane rotation is a real measurement with depth.
  reliable: Partial<Record<MetricKey, boolean>>;
};

const clamp = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[xs.length >> 1] : 0);
/** Robust percentile (0..1). Used instead of max/min so a single noisy Vision frame can't
 *  dominate a metric — the old max/max-min made head + posture unstable to frame sampling
 *  (validated: same swing graded posture 60/35/50 at 30/40/48 frames). */
const pctl = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.min(s.length - 1, Math.round(p * (s.length - 1))))];
};
const ok = (p?: Pt, c = 0.15): p is Pt => !!p && p.c >= c;
const argmax = (xs: number[]) => xs.reduce((bi, v, i, a) => (v > a[bi] ? i : bi), 0);

/** Map Apple Vision / ARKit body joints into a PoseFrame. Vision gives [x, y, conf]
 *  (2D); ARKit 3D body tracking gives [x, y, z, conf] — both share the rig joint
 *  names, so one mapper covers both and the engine reads z when it's present. */
export function frameFromVision(joints: Record<string, number[]>, t: number): PoseFrame {
  const g = (k: string): Pt | undefined => {
    const v = joints[k];
    if (!v) return undefined;
    return v.length >= 4 ? { x: v[0], y: v[1], z: v[2], c: v[3] } : { x: v[0], y: v[1], c: v[2] };
  };
  // some joints differ in rawValue between Vision/ARKit — try a couple of candidates.
  const gm = (...keys: string[]): Pt | undefined => { for (const k of keys) { const p = g(k); if (p) return p; } return undefined; };
  return {
    t,
    head: g('head_joint'), chin: g('jaw_joint'), neck: g('neck_1_joint'),
    eyeL: gm('left_eye_joint', 'left_eye'), eyeR: gm('right_eye_joint', 'right_eye'),
    shoulderL: g('left_shoulder_1_joint'), shoulderR: g('right_shoulder_1_joint'),
    elbowL: g('left_forearm_joint'), elbowR: g('right_forearm_joint'),
    hipL: g('left_upLeg_joint'), hipR: g('right_upLeg_joint'), root: g('root'),
    kneeL: g('left_leg_joint'), kneeR: g('right_leg_joint'),
    footL: g('left_foot_joint'), footR: g('right_foot_joint'),
    wristL: g('left_hand_joint'), wristR: g('right_hand_joint'),
  };
}

/** Body height (head → lowest foot) per frame; the scale everything normalizes by.
 *  0 when NO frame shows head + a foot — the caller must not grade then: every read below
 *  is a %-of-body-height, and the old fallback of 1 silently graded %-of-FRAME instead
 *  (a half-body clip read as a wildly different hitter). audit 2026-09-05, doc 34 F12. */
function bodyHeight(frames: PoseFrame[]): number {
  const hs: number[] = [];
  for (const f of frames) {
    const feet = [f.footL, f.footR].filter((p): p is Pt => ok(p));
    if (ok(f.head) && feet.length) hs.push(f.head.y - Math.min(...feet.map((p) => p.y)));
  }
  return median(hs);
}

export type Calibration = {
  head: { free: number; slope: number };
  posture: { angCoeff: number; riseCoeff: number };
  balance: { offCoeff: number };
  stride: { deadBelow: number; softBelow: number; scores: [number, number, number] };
};

/** The shipping APP calibration. The app always uses this (callers omit `cal`), so its
 *  grades never move. The web passes its own WEB_CALIBRATION to tune independently. */
export const DEFAULT_CALIBRATION: Calibration = {
  head: { free: 3.5, slope: 6.5 },
  posture: { angCoeff: 3.4, riseCoeff: 4.2 },
  balance: { offCoeff: 130 },
  stride: { deadBelow: 2, softBelow: 6, scores: [62, 78, 82] },
};

/** Grade a swing from its pose sequence. Scores only the reliable in-plane reads. */
export function swingMetrics(frames: PoseFrame[], cal: Calibration = DEFAULT_CALIBRATION): SwingRead {
  const scores: MetricScores = {};
  const stats: Partial<Record<MetricKey, string>> = {};
  const reliable: Partial<Record<MetricKey, boolean>> = {};
  if (frames.length < 2) return { scores, stats, reliable };
  const bh = bodyHeight(frames);
  if (!(bh > 0)) {
    // no body scale (head and feet never both seen): leave the in-plane reads UNSCORED and
    // flagged unreliable so the report shows them as estimates, never a mis-scaled grade
    return { scores, stats, reliable: { head: false, posture: false, balance: false } };
  }
  // CONF: confidence floor for the range-sensitive reads (head/posture/balance) — Vision emits
  // low-confidence MISDETECTIONS (body half out of frame, conf ~0.3-0.5) that sit at the frame
  // edge then jump to the real body; that jump alone floored ~6 clips. Use confident frames only.
  const CONF = 0.5;

  // HEAD & EYES — max head travel from its average spot, as % of body height. We grade a
  // QUIET, controlled head, NOT a frozen one: skilled hitters move the head a small, smooth
  // amount (docs/research/24 §3.1, "never coach a frozen head"). So a normal travel band is
  // free and we only penalize EXCESS drift. (Signed swivel-vs-lunge needs a facing gate — a
  // follow-up; here we grade bounded travel, which is honest without it.)
  // RELATIVE TO THE BODY (pelvis, fallback neck), not the frame: on a handheld phone the whole
  // body translates as the camera pans, and absolute head travel then reads that camera motion as
  // "head drift" (it floored ~20/67 real clips to 0). Measuring head − root cancels the shared
  // translation, so we grade the head moving relative to the swing's center — the actual cue.
  const rel = frames
    .filter((f) => ok(f.head, CONF) && (ok(f.root, CONF) || ok(f.neck, CONF)))
    .map((f) => { const a = ok(f.root, CONF) ? (f.root as Pt) : (f.neck as Pt); return { x: (f.head as Pt).x - a.x, y: (f.head as Pt).y - a.y }; });
  if (rel.length >= 2) {
    const mx = rel.reduce((s, p) => s + p.x, 0) / rel.length;
    const my = rel.reduce((s, p) => s + p.y, 0) / rel.length;
    const dists = rel.map((p) => Math.hypot(p.x - mx, p.y - my));
    const drift = (100 * pctl(dists, 0.9)) / bh; // 90th pct, not max — robust to a stray frame
    // A small, smooth move is fine (not frozen), but the old 7%BH free band + gentle slope
    // pegged EVERY swing at ~100 (validated on 13 real clips — no discrimination). Tightened
    // so real differences in head travel actually register, while a genuinely quiet head
    // (~3%BH) still scores top. docs/research/24 §3.1 (quiet, not frozen).
    scores.head = Math.round(clamp(100 - Math.max(0, drift - cal.head.free) * cal.head.slope));
    stats.head = `${Math.round(drift)}% travel — ${drift < 5 ? 'quiet and controlled' : drift < 11 ? 'a little busy' : 'head drifting a lot'}`;
  }

  // POSTURE & SPINE — spine lean (root→neck) should hold; the head shouldn't rise
  // off the hips (standing up out of the swing).
  const spineAng: number[] = [];
  const headRise: number[] = [];
  for (const f of frames) {
    if (ok(f.neck, CONF) && ok(f.root, CONF)) spineAng.push((Math.atan2(f.neck.x - f.root.x, f.neck.y - f.root.y) * 180) / Math.PI);
    if (ok(f.head, CONF) && ok(f.root, CONF)) headRise.push(f.head.y - f.root.y);
  }
  if (spineAng.length >= 2 && headRise.length >= 2) {
    // ROBUST range (p90-p10), not max-min: one noisy Vision frame used to swing posture wildly
    // (60/35/50 for the same swing at 30/40/48 frames). Stiffer coefficients so the visible
    // "standing up out of the hinge" actually shows (a coach saw it on 13/13). docs/research/24 §3.2.
    const angRange = pctl(spineAng, 0.9) - pctl(spineAng, 0.1);
    const rise = (100 * (pctl(headRise, 0.9) - pctl(headRise, 0.1))) / bh;
    const score = Math.round(clamp(100 - angRange * cal.posture.angCoeff - rise * cal.posture.riseCoeff));
    scores.posture = score;
    // stat tracks the SCORE (was inconsistent: could say "stays down" while grading WORK)
    stats.posture = score >= 78 ? 'spine held — stays down' : score >= 58 ? 'rises a little' : 'standing up out of it';
  }

  // BALANCE & BASE — the hips stay centered over the base (not lunging/falling out).
  const offs: number[] = [];
  const bases: number[] = [];
  for (const f of frames) {
    if (ok(f.footL, CONF) && ok(f.footR, CONF) && ok(f.root, CONF)) {
      const base = Math.abs(f.footL.x - f.footR.x);
      bases.push((100 * base) / bh);
      offs.push(Math.abs(f.root.x - (f.footL.x + f.footR.x) / 2) / (base + 1e-6));
    }
  }
  if (offs.length) {
    const avgOff = offs.reduce((a, b) => a + b, 0) / offs.length;
    scores.balance = Math.round(clamp(100 - avgOff * cal.balance.offCoeff));
    stats.balance = `base ~${Math.round(median(bases))}% · ${avgOff < 0.35 ? 'balanced over the base' : 'leaning out'}`;
  }

  // STRIDE — the lead foot's travel toward the pitcher (the foot that moves most).
  const footTravel = (which: 'footL' | 'footR'): number => {
    const xs = frames.map((f) => f[which]).filter((p): p is Pt => ok(p)).map((p) => p.x);
    return xs.length >= 2 ? Math.max(...xs) - Math.min(...xs) : 0;
  };
  // Stride MAGNITUDE side-on is depth-compressed and there is no validated youth norm
  // (docs/research/24 §3.4), so we DON'T grade absolute length harshly — a quiet stride is
  // not a fault. We give gentle credit for a present, controlled step and only softly flag a
  // near-dead lower half. (Real grading of this is within-session TREND, a follow-up.)
  const stride = (Math.max(footTravel('footL'), footTravel('footR')) / bh) * 100;
  if (frames.some((f) => ok(f.footL) || ok(f.footR))) {
    scores.stride = Math.round(clamp(stride < cal.stride.deadBelow ? cal.stride.scores[0] : stride < cal.stride.softBelow ? cal.stride.scores[1] : cal.stride.scores[2]));
    stats.stride = stride < cal.stride.deadBelow ? 'very quiet lower half' : stride < cal.stride.softBelow ? 'a soft step in' : 'a clear stride to the pitcher';
  }

  // ROTATION / SEQUENCE — DELIBERATELY NOT COMPUTED. Hip-shoulder separation and the
  // "hips before hands" kinematic sequence are transverse-plane rotations about the vertical
  // axis; they foreshorten to ambiguity from a single side-on camera, and the monocular 3D
  // lift is unvalidated (docs/research/24 §3.5, §5.2). Grading it would be a fabricated
  // number, so it stays walled off the score and is surfaced in the UI as "needs 3D — not
  // graded". (hand path likewise stays an estimate, left undefined.)
  return { scores, stats, reliable };
}

// Joints surfaced in the pose carousel + the label for a frame at fraction `frac`.
const PHASE_JOINTS = ['head', 'chin', 'eyeL', 'eyeR', 'neck', 'shoulderL', 'shoulderR', 'elbowL', 'elbowR', 'wristL', 'wristR', 'root', 'hipL', 'hipR', 'kneeL', 'kneeR', 'footL', 'footR'] as const;
const phaseLabel = (frac: number) => (frac <= 0.05 ? 'Setup' : frac >= 0.95 ? 'Finish' : frac < 0.5 ? 'Load' : 'Contact');

/** One frame → a carousel skeleton (only the joints the capture actually saw). */
function phaseFrom(f: PoseFrame, label: string): PosePhase {
  const joints: Record<string, [number, number]> = {};
  for (const key of PHASE_JOINTS) {
    const p = f[key];
    if (ok(p)) joints[key] = [p.x, p.y];
  }
  return { label, joints, t: f.t }; // carry the frame time so the UI can fetch the real video frame
}

/** How many usable joints this frame has. */
function jointCount(f: PoseFrame): number {
  let n = 0;
  for (const key of PHASE_JOINTS) if (ok(f[key])) n++;
  return n;
}

/** Snap a phase index to the nearest frame with a usable body (>=4 joints) within `win`.
 *  Vision drops the MOTION-BLURRED contact frame, which left the marquee Contact card empty
 *  (validated on real footage); the nearest tracked frame keeps a real body + a fetchable
 *  reference image. Returns the original index if nothing nearby is tracked. */
function nearestTracked(frames: PoseFrame[], idx: number, win = 6): number {
  const c = Math.max(0, Math.min(frames.length - 1, idx));
  if (jointCount(frames[c]) >= 4) return c;
  for (let d = 1; d <= win; d++) {
    if (c - d >= 0 && jointCount(frames[c - d]) >= 4) return c - d;
    if (c + d < frames.length && jointCount(frames[c + d]) >= 4) return c + d;
  }
  return c;
}

/**
 * Up to 4 key frames as skeletons (Setup → Load → Contact → Finish) for the
 * swipeable pose viewer. When `contactIdx` is given (the audio crack pinned the
 * real contact frame), Contact is THAT frame and Load is midway to it; otherwise
 * we fall back to evenly-spaced frames (the legacy behavior — no regression).
 */
function keyPhases(frames: PoseFrame[], contactIdx?: number): PosePhase[] {
  const n = frames.length;
  if (n === 0) return [];

  if (contactIdx == null || contactIdx < 0) {
    const count = Math.min(4, n);
    const idxs = count === 1 ? [0] : Array.from({ length: count }, (_, i) => Math.round((i * (n - 1)) / (count - 1)));
    return idxs
      .map((fi0) => phaseFrom(frames[nearestTracked(frames, fi0)], phaseLabel(n === 1 ? 0.5 : fi0 / (n - 1))))
      .filter((ph) => Object.keys(ph.joints).length >= 4);
  }

  // Anchored to the real contact frame. Dedupe by index (e.g. when contact is near
  // the start Load collapses onto it); keep the more meaningful label on a collision.
  const ph = phaseIndicesFromContact(n, contactIdx);
  const candidates = [
    { idx: nearestTracked(frames, ph.setup), label: 'Setup', prio: 1 },
    { idx: nearestTracked(frames, ph.load), label: 'Load', prio: 0 },
    { idx: nearestTracked(frames, ph.contact), label: 'Contact', prio: 3 },
    { idx: nearestTracked(frames, ph.finish), label: 'Finish', prio: 2 },
  ];
  const byIdx = new Map<number, { label: string; prio: number }>();
  for (const c of candidates) {
    const ex = byIdx.get(c.idx);
    if (!ex || c.prio > ex.prio) byIdx.set(c.idx, { label: c.label, prio: c.prio });
  }
  return [...byIdx.keys()]
    .sort((a, b) => a - b)
    .map((fi) => phaseFrom(frames[fi], byIdx.get(fi)!.label))
    .filter((p) => Object.keys(p.joints).length >= 4);
}

/** The hands point per frame (wrist midpoint; falls back to head) — the motion signal
 *  whose ramp into contact defines the swing window (swing-phases). */
function handsPoint(f: PoseFrame): { x: number; y: number } {
  const ws = [f.wristL, f.wristR].filter((p): p is Pt => ok(p));
  if (ws.length === 2) return { x: (ws[0].x + ws[1].x) / 2, y: (ws[0].y + ws[1].y) / 2 };
  if (ws.length === 1) return { x: ws[0].x, y: ws[0].y };
  return ok(f.head) ? { x: f.head.x, y: f.head.y } : { x: 0.5, y: 0.5 };
}

/** Carousel skeletons at the motion-anchored phase frames: Set (pre-load) → Load (launch)
 *  → Contact → Finish (follow-through). Dedup-safe; keeps the meaningful label on a tie. */
function phasesFromKeyFrames(frames: PoseFrame[], kf: { set: number; launch: number; contact: number; follow: number }): PosePhase[] {
  const prio: Record<string, number> = { Setup: 1, Load: 0, Contact: 3, Finish: 2 };
  const byIdx = new Map<number, string>();
  // snap each key index to the nearest TRACKED frame (Vision drops the blurred contact frame)
  for (const [idx0, label] of [[kf.set, 'Setup'], [kf.launch, 'Load'], [kf.contact, 'Contact'], [kf.follow, 'Finish']] as [number, string][]) {
    const idx = nearestTracked(frames, idx0);
    const ex = byIdx.get(idx);
    if (!ex || prio[label] > prio[ex]) byIdx.set(idx, label);
  }
  return [...byIdx.keys()].sort((a, b) => a - b).map((idx) => phaseFrom(frames[idx], byIdx.get(idx)!)).filter((p) => Object.keys(p.joints).length >= 4);
}

/** Bridge: mapped PoseFrames → a real SwingReport (the 3D `reliable` flags carry
 *  through, so a 3D-measured sequence shows as a real read, not an estimate). When a
 *  `contact` crack is supplied, the Contact pose is pinned to it and the report
 *  carries a (still-uncalibrated) contact-quality read.
 *
 *  On a full clip (≥12 frames) the graded metrics are scored over the SWING window only
 *  (launch → follow-through), anchored at the audio contact (or the hand-motion peak when
 *  there's no crack) — scoring the whole clip lets the walk-up + settle tank head/posture
 *  (docs/research/23). Short synthetic sequences keep the legacy whole-sequence behavior. */
export function reportFromFrames(
  frames: PoseFrame[],
  ctx: { name: string; sport: Sport; ageMode: AgeMode },
  contact?: CrackContact,
  cal: Calibration = DEFAULT_CALIBRATION,
): SwingReport {
  const contactIdx = contact ? nearestFrameIdx(contact.t, frames) : undefined;
  const contactQuality = contact ? readContactQuality(contact) : undefined;

  let scoreFrames = frames;
  let poses: PosePhase[];
  if (frames.length >= 12) {
    const motion = speedSeries(frames.map(handsPoint));
    const anchor = contactIdx ?? argmax(motion); // audio crack, else the hand-speed peak ≈ contact
    const seg = segmentSwing({ motion, contactIdx: anchor });
    const win = frames.slice(seg.swing.start, seg.followThrough.end + 1);
    scoreFrames = win.length >= 4 ? win : frames; // window to the swing; guard a degenerate window
    poses = phasesFromKeyFrames(frames, seg.keyFrames);
    if (poses.length < 2) poses = keyPhases(frames, contactIdx); // safety fallback
  } else {
    poses = keyPhases(frames, contactIdx);
  }

  const { scores, stats, reliable } = swingMetrics(scoreFrames, cal);
  const report = buildReport({
    name: ctx.name, sport: ctx.sport, ageMode: ctx.ageMode,
    scores, stats, reliable, context: 'Your swing',
    poses, contactQuality,
  });
  // additive: the raw signals for the mechanics-trend layer (docs/research/32).
  // Never alters the graded report; absent when the stream is too thin.
  const signals = swingSignals(frames);
  if (signals) report.signals = signals;
  return report;
}

/** Bridge from raw joints (swing-capture.poseFromVideo 2D, or ARKit 3D) → a report. */
export function reportFromPoseFrames(
  frames: { t?: number; joints: Record<string, number[]> }[],
  ctx: { name: string; sport: Sport; ageMode: AgeMode },
  contact?: CrackContact,
  cal: Calibration = DEFAULT_CALIBRATION,
): SwingReport {
  return reportFromFrames(frames.map((f, i) => frameFromVision(f.joints, f.t ?? i)), ctx, contact, cal);
}

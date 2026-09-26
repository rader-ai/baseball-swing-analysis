/**
 * pose-signals.ts — RAW, unclamped mechanical signals from a swing's pose stream,
 * plus the subject-continuity guard. PURE + node-testable, ZERO RN imports.
 *
 * Why this exists (docs/research/30, 32): the graded 0-100 scores are byte-frozen
 * and honest about their limit, a single absolute grade barely tracks a coach's
 * eye. But WITHIN-hITTER CHANGE of the raw signals is far more defensible: same
 * kid, same setup, same pipeline, so the systematic biases cancel. This module
 * captures the raw values the engine currently computes and throws away, so the
 * mechanics-trend layer can tell the week-over-week story. It is ADDITIVE: the
 * frozen grading path in pose-metrics.ts is untouched.
 *
 * Signals (all lower = quieter/steadier, matching what a coach cues):
 *   headDriftPctBh   — p90 head travel relative to the pelvis, % of body height
 *   postureRangeDeg  — spine-angle p90-p10 range + head-rise, the stand-up signal
 *   balanceOffRatio  — mean |pelvis off base center| / base width
 * All computed over the SWING WINDOW (segmentSwing on hand speed), same windowing
 * the engine validated (docs/research/23: whole-clip scoring destroys the signal).
 */
import type { PoseFrame, Pt } from './pose-metrics.ts';
import { segmentSwing, speedSeries } from './swing-phases.ts';

const CONF = 0.5; // the engine's confident-joint floor
const okPt = (p: Pt | undefined, c = CONF): p is Pt => !!p && p.c >= c;

const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pctl = (xs: number[], p: number): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.min(s.length - 1, Math.round(p * (s.length - 1))))];
};

function bodyHeight(frames: PoseFrame[]): number {
  const hs: number[] = [];
  for (const f of frames) {
    const feet = [f.footL, f.footR].filter((p): p is Pt => okPt(p, 0.15));
    if (okPt(f.head, 0.15) && feet.length) hs.push(f.head.y - Math.min(...feet.map((p) => p.y)));
  }
  return median(hs); // 0 = no body scale; swingSignals returns null then (doc 34 F12)
}

function handsPoint(f: PoseFrame): { x: number; y: number } {
  const ws = [f.wristL, f.wristR].filter((p): p is Pt => okPt(p, 0.15));
  if (ws.length === 2) return { x: (ws[0].x + ws[1].x) / 2, y: (ws[0].y + ws[1].y) / 2 };
  if (ws.length === 1) return { x: ws[0].x, y: ws[0].y };
  return okPt(f.head, 0.15) ? { x: f.head.x, y: f.head.y } : { x: 0.5, y: 0.5 };
}

/** Subject-continuity guard (same defense the web analyzer ships): a parent in
 *  frame steals the single-pose detector for runs of frames and fabricates giant
 *  motion reads. The batter is the dominant cluster of pelvis positions; frames
 *  whose anchor sits far from that cluster's median are another body. */
const MAX_DEV_BH = 0.22;
export function keepStableSubject(frames: PoseFrame[]): PoseFrame[] {
  const anchor = (f: PoseFrame): Pt | null => (okPt(f.root) ? f.root : okPt(f.neck) ? f.neck : null);
  const anchored = frames.map((f) => ({ f, a: anchor(f) }));
  const pts = anchored.filter((r) => r.a).map((r) => r.a as Pt);
  if (pts.length < 3) return frames;
  const cx = median(pts.map((p) => p.x));
  const cy = median(pts.map((p) => p.y));
  const bh = bodyHeight(frames);
  if (!(bh > 0)) return frames; // no body scale to judge stability against — keep everything
  const maxDev = MAX_DEV_BH * bh;
  return anchored.filter((r) => !r.a || Math.hypot(r.a.x - cx, r.a.y - cy) <= maxDev).map((r) => r.f);
}

export type SwingSignals = {
  headDriftPctBh: number;
  postureRangeDeg: number;
  balanceOffRatio: number;
  framesUsed: number;
};

/** Raw signals for ONE swing. Applies the subject guard, windows to the swing,
 *  and returns null when the stream is too thin to read honestly. */
export function swingSignals(rawFrames: PoseFrame[]): SwingSignals | null {
  const frames = keepStableSubject(rawFrames);
  if (frames.length < 8) return null;
  const bh = bodyHeight(frames);
  if (!(bh > 0)) return null; // head + feet never both seen: no scale, no signals

  // window to the swing (hand-speed peak ≈ contact), engine-identical approach
  const motion = speedSeries(frames.map(handsPoint));
  let peak = 0;
  for (let i = 1; i < motion.length; i++) if (motion[i] > motion[peak]) peak = i;
  const seg = segmentSwing({ motion, contactIdx: peak });
  const win = frames.slice(seg.swing.start, seg.followThrough.end + 1);
  if (win.length < 4) return null;

  // head: p90 travel relative to the pelvis (fallback neck), %BH
  const rel = win
    .filter((f) => okPt(f.head) && (okPt(f.root) || okPt(f.neck)))
    .map((f) => {
      const a = okPt(f.root) ? (f.root as Pt) : (f.neck as Pt);
      return { x: (f.head as Pt).x - a.x, y: (f.head as Pt).y - a.y };
    });
  if (rel.length < 2) return null;
  const mx = mean(rel.map((p) => p.x));
  const my = mean(rel.map((p) => p.y));
  const headDriftPctBh = (100 * pctl(rel.map((p) => Math.hypot(p.x - mx, p.y - my)), 0.9)) / bh;

  // posture: spine-angle robust range + head-rise range (the stand-up signal)
  const ang: number[] = [];
  const rise: number[] = [];
  for (const f of win) {
    if (okPt(f.neck) && okPt(f.root)) ang.push((Math.atan2(f.neck.x - f.root.x, f.neck.y - f.root.y) * 180) / Math.PI);
    if (okPt(f.head) && okPt(f.root)) rise.push(f.head.y - f.root.y);
  }
  const postureRangeDeg =
    ang.length >= 2 && rise.length >= 2
      ? pctl(ang, 0.9) - pctl(ang, 0.1) + (100 * (pctl(rise, 0.9) - pctl(rise, 0.1))) / bh
      : 0;

  // balance: mean pelvis offset from base center, as a fraction of base width
  const offs: number[] = [];
  for (const f of win) {
    if (okPt(f.footL) && okPt(f.footR) && okPt(f.root)) {
      const base = Math.abs(f.footL.x - f.footR.x);
      offs.push(Math.abs(f.root.x - (f.footL.x + f.footR.x) / 2) / (base + 1e-6));
    }
  }
  const balanceOffRatio = offs.length ? mean(offs) : 0;

  return { headDriftPctBh, postureRangeDeg, balanceOffRatio, framesUsed: win.length };
}

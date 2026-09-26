/**
 * swing-analysis.ts — the swing-report brain (pure, node-testable).
 *
 * Turns per-metric pose scores into a graded, plain-English swing report. Encodes
 * the knowledge base (docs/research/14): the honesty rule (2D reads in-plane
 * mechanics reliably; rotation/sequence are estimates), an AGE MODE (under-11s
 * get encouragement + one cue, no rotation grading — never an MLB scorecard on a
 * 6-year-old), and MYTH-FREE drills (rotate against a firm front leg, never
 * "squish the bug"; match the pitch, never "swing down").
 *
 * No React-Native / store runtime imports, so it runs under `node --test`.
 */

import type { ContactQuality } from './contact-sync.ts';
import type { Sport } from './engine-types.ts';

export type Grade = 'great' | 'good' | 'work';
export type MetricKey = 'head' | 'posture' | 'balance' | 'stride' | 'sequence' | 'hands';
export type AgeMode = 'young' | 'full'; // young = under ~11 (encouragement-first, no rotation grading)

export type MetricRead = {
  key: MetricKey;
  label: string;
  grade: Grade;
  score: number; // 0-100
  stat: string; // the measured one-liner ("7% drift — eyes locked")
  good: string; // what good looks like
  why: string; // why it matters
  reliable: boolean; // 2D-from-a-phone honesty: true = in-plane/reliable, false = estimate
  drill?: { name: string; how: string }; // attached when grade !== 'great'
};

// A swing-phase skeleton for the swipeable pose viewer: normalized [x, y] joints,
// y-UP (Apple Vision convention). Joint keys match pose-metrics' PoseFrame fields.
export type PosePhase = {
  label: string;
  joints: Record<string, [number, number]>;
  t?: number; // the source-frame presentation time (s) — lets the UI pull the real video frame here
};

export type SwingReport = {
  name: string;
  sport: Sport;
  ageMode: AgeMode;
  context: string; // "Tee work"
  overallGrade: number; // 0-100 overall
  headline: string; // the coach's one-liner
  metrics: MetricRead[];
  poses?: PosePhase[]; // key swing-phase skeletons (setup → finish) for the pose carousel
  contactQuality?: ContactQuality; // a rough "how flush" read from the bat-crack sound — ALWAYS an estimate (uncalibrated)
  captureMode?: '2d' | '3d'; // how the pose was read: '3d' (iOS 17+ monocular depth) or '2d'. Unset for the sample.
  /** RAW mechanical signals for the mechanics-trend layer (docs/research/32) —
   *  numbers only, additive, never shown as a grade. Absent when the pose stream
   *  was too thin to read honestly. */
  signals?: { headDriftPctBh: number; postureRangeDeg: number; balanceOffRatio: number; framesUsed: number };
};

export type MetricScores = Partial<Record<MetricKey, number>>;

/** The rubric: per-metric coaching content + a myth-free drill for when it needs work. */
const LIBRARY: Record<MetricKey, Omit<MetricRead, 'grade' | 'score' | 'stat'>> = {
  head: {
    key: 'head', label: 'Quiet head', reliable: true,
    good: 'A small, smooth, repeatable head move with your eyes on the ball — quiet, not frozen.',
    why: 'A quiet head keeps your eyes on the ball, so you square it up more often. (Skilled hitters move a little — we look for quiet and repeatable, not perfectly still.)',
    drill: { name: 'Quiet eyes', how: 'Pick a spot on the ball and keep your eyes there all the way through contact. 10 off the tee.' },
  },
  posture: {
    key: 'posture', label: 'Posture', reliable: true,
    good: 'A small hinge at setup, held through the turn — you stay down in the swing.',
    why: 'Standing up early pulls the barrel off the ball and you top it. Holding your angle keeps you on it.',
    drill: { name: 'Hold your angle', how: 'Set a slight hinge, then rotate without standing up. Feel your chest stay over the plate.' },
  },
  balance: {
    key: 'balance', label: 'Balance & base', reliable: true,
    good: 'Athletic, balanced base; you finish in control, not falling out.',
    why: 'A stable base lets you rotate around a solid axis instead of spinning out or lunging.',
    drill: { name: 'Stick the finish', how: 'Swing and freeze — hold your finish for two seconds. If you tip over, widen the base a touch.' },
  },
  stride: {
    key: 'stride', label: 'Lower half / stride', reliable: false,
    good: 'A short, soft step at the pitcher that lands closed, then a firm front leg to rotate against.',
    why: "Power comes from the ground up. No stride means it's mostly arms — leaving real pop on the table.",
    drill: { name: 'Step & go', how: 'Start a touch narrower, take a small step toward the pitcher, and rotate against a firm front leg. (Not the back foot.)' },
  },
  sequence: {
    key: 'sequence', label: 'Hips lead hands', reliable: false,
    good: 'Hips start to open a beat before the hands fire — the lower half leads.',
    why: 'When the hips lead and the hands lag, that stretch is where bat speed comes from.',
    drill: { name: 'Hips, then hands', how: 'Slow swings: turn your belt buckle to the pitcher first, let your hands stay back, then fire. 5 slow, 5 normal.' },
  },
  hands: {
    key: 'hands', label: 'Hand path', reliable: true,
    good: 'Hands take a tight, direct path to the ball and extend through it.',
    why: 'A short, connected path gets the barrel to the ball quicker and keeps it on plane longer.',
    drill: { name: 'Short to it', how: 'Tee drill: feel the knob lead, hands inside the ball, then extend through. No casting out and around.' },
  },
};

/** Metrics we GRADE per age mode. We only grade what a single side-on camera can truthfully
 *  measure (docs/research/24): head, posture (forward trunk lean), balance/base, stride.
 *  Rotation/sequence is transverse-plane (needs depth) and hand-path is experimental — both
 *  are walled off the grade and surfaced as "needs 3D / not graded", never scored. Under-11s
 *  drop stride too (don't grade an MLB scorecard on a 6-year-old). */
const METRICS_BY_MODE: Record<AgeMode, MetricKey[]> = {
  young: ['head', 'balance', 'posture'],
  full: ['head', 'posture', 'balance', 'stride'],
};

/** Overall-grade weighting — trust × discrimination. Validated on 13 real swings: posture and
 *  balance carry the signal a coach actually sees (incl. the stand-up flaw), while stride
 *  magnitude is depth-limited and barely gradable (docs/research/24 §2.2/§3.4), so it gets a
 *  small weight. Head stays meaningful (the cleanest motion read) but no longer dominates. */
const METRIC_WEIGHT: Partial<Record<MetricKey, number>> = {
  head: 25, posture: 30, balance: 25, stride: 10,
  // walled off the grade (weight 0): never scored from a single side-on camera.
  sequence: 0, hands: 0,
};

export function ageModeForCohort(cohort: string): AgeMode {
  return cohort === 'teeball' || cohort === '8-9' ? 'young' : 'full';
}

export function gradeFor(score: number): Grade {
  if (score >= 78) return 'great';
  if (score >= 58) return 'good';
  return 'work';
}

export const GRADE_LABEL: Record<Grade, string> = { great: 'GREAT', good: 'GOOD', work: 'WORK ON IT' };

/** Overall grade (0-100): a TRUST-weighted mean of the shown metric scores, so the
 *  reads we measure cleanly (head, posture) drive the grade more than the estimates (stride).
 *  Falls back to a plain mean if no weights apply. */
export function overallGrade(metrics: MetricRead[]): number {
  if (!metrics.length) return 0;
  let wsum = 0;
  let w = 0;
  for (const m of metrics) {
    const mw = METRIC_WEIGHT[m.key] ?? 0;
    wsum += m.score * mw;
    w += mw;
  }
  return w > 0 ? Math.round(wsum / w) : Math.round(metrics.reduce((a, m) => a + m.score, 0) / metrics.length);
}

/** The coach's headline — leads with a strength, then the one thing to work on.
 *  Punches up, never down (kid-safe), and is gentler in young mode. */
function headlineFor(metrics: MetricRead[], mode: AgeMode): string {
  const great = metrics.filter((m) => m.grade === 'great');
  const work = metrics.find((m) => m.grade === 'work') ?? metrics.slice().sort((a, b) => a.score - b.score)[0];
  if (mode === 'young') {
    return great.length
      ? `Great ${great[0].label.toLowerCase()} — you look like a hitter out there! Keep ripping it.`
      : `Love the energy out there — keep taking big, balanced cuts!`;
  }
  const strength = great.length ? great.map((m) => m.label.toLowerCase()).slice(0, 2).join(' and ') : 'solid contact';
  return work && work.grade !== 'great'
    ? `Your ${strength} look great. The one to chase next: ${work.label.toLowerCase()}.`
    : `Everything's clicking — ${strength} all grading out. Keep it rolling.`;
}

/** Build a report from per-metric scores (0-100). Applies the age mode + honesty + myth-free drills. */
export function buildReport(input: {
  name: string;
  sport: Sport;
  ageMode: AgeMode;
  scores: MetricScores;
  stats?: Partial<Record<MetricKey, string>>;
  // per-metric reliability override (e.g. 3D capture makes `sequence` a real read).
  reliable?: Partial<Record<MetricKey, boolean>>;
  context?: string;
  poses?: PosePhase[]; // key swing-phase skeletons for the pose carousel
  contactQuality?: ContactQuality; // optional bat-crack flushness read (estimate)
}): SwingReport {
  const keys = METRICS_BY_MODE[input.ageMode];
  const metrics: MetricRead[] = keys.map((key) => {
    const score = clamp(input.scores[key] ?? 70);
    const grade = gradeFor(score);
    const base = LIBRARY[key];
    return {
      ...base,
      grade,
      score,
      reliable: input.reliable?.[key] ?? base.reliable,
      stat: input.stats?.[key] ?? '',
      drill: grade === 'great' ? undefined : base.drill,
    };
  });
  return {
    name: input.name,
    sport: input.sport,
    ageMode: input.ageMode,
    context: input.context ?? 'Tee work',
    overallGrade: overallGrade(metrics),
    headline: headlineFor(metrics, input.ageMode),
    metrics,
    poses: input.poses,
    contactQuality: input.contactQuality,
  };
}

// Four illustrative swing-phase skeletons (normalized [x,y], y-UP) for the sample
// report's pose carousel — a right-handed cut: setup → load → contact → finish.
const SAMPLE_POSES: PosePhase[] = [
  { label: 'Setup', joints: { head: [0.50, 0.92], chin: [0.50, 0.88], eyeL: [0.495, 0.915], eyeR: [0.520, 0.915], neck: [0.50, 0.84], shoulderL: [0.44, 0.82], shoulderR: [0.56, 0.82], elbowL: [0.53, 0.76], elbowR: [0.60, 0.78], wristL: [0.60, 0.74], wristR: [0.62, 0.77], root: [0.50, 0.55], hipL: [0.45, 0.55], hipR: [0.55, 0.55], kneeL: [0.44, 0.32], kneeR: [0.56, 0.32], footL: [0.42, 0.10], footR: [0.58, 0.10] } },
  { label: 'Load', joints: { head: [0.48, 0.92], chin: [0.48, 0.88], eyeL: [0.475, 0.915], eyeR: [0.500, 0.915], neck: [0.48, 0.84], shoulderL: [0.42, 0.82], shoulderR: [0.55, 0.81], elbowL: [0.54, 0.79], elbowR: [0.61, 0.81], wristL: [0.64, 0.80], wristR: [0.66, 0.83], root: [0.49, 0.55], hipL: [0.44, 0.55], hipR: [0.55, 0.55], kneeL: [0.43, 0.32], kneeR: [0.57, 0.33], footL: [0.38, 0.10], footR: [0.60, 0.10] } },
  { label: 'Contact', joints: { head: [0.50, 0.90], chin: [0.50, 0.86], eyeL: [0.495, 0.895], eyeR: [0.520, 0.895], neck: [0.50, 0.82], shoulderL: [0.46, 0.80], shoulderR: [0.58, 0.80], elbowL: [0.40, 0.72], elbowR: [0.44, 0.70], wristL: [0.34, 0.66], wristR: [0.32, 0.64], root: [0.52, 0.54], hipL: [0.47, 0.54], hipR: [0.58, 0.55], kneeL: [0.45, 0.31], kneeR: [0.60, 0.33], footL: [0.36, 0.10], footR: [0.64, 0.11] } },
  { label: 'Finish', joints: { head: [0.52, 0.90], chin: [0.52, 0.86], eyeL: [0.515, 0.895], eyeR: [0.540, 0.895], neck: [0.52, 0.82], shoulderL: [0.50, 0.80], shoulderR: [0.60, 0.82], elbowL: [0.44, 0.85], elbowR: [0.50, 0.87], wristL: [0.40, 0.92], wristR: [0.42, 0.94], root: [0.53, 0.54], hipL: [0.48, 0.54], hipR: [0.60, 0.55], kneeL: [0.46, 0.31], kneeR: [0.62, 0.33], footL: [0.40, 0.10], footR: [0.66, 0.12] } },
];

/** A realistic demo report (a real reference swing — quiet head, great posture, stride to chase).
 *  Used for the in-app demo and previews; never persisted as a real result. */
export function sampleReport(name = 'Sample Hitter', sport: Sport = 'baseball', ageMode: AgeMode = 'full'): SwingReport {
  return buildReport({
    name, sport, ageMode, context: 'Tee work',
    scores: { head: 90, posture: 88, balance: 85, stride: 42, sequence: 52, hands: 74 },
    stats: {
      head: '7% drift — eyes locked',
      posture: 'spine held through contact',
      balance: 'wide & athletic',
      stride: 'almost no stride',
      sequence: 'hips & hands fire together',
      hands: 'direct, slightly long out front',
    },
    poses: SAMPLE_POSES,
  });
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

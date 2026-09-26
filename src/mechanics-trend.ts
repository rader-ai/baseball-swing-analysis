/**
 * mechanics-trend.ts — the week-over-week swing MECHANICS story. PURE + node-tested.
 *
 * The design bet (docs/research/32): we cannot honestly out-grade a coach with a
 * single absolute score (doc 30: coach correlation ~0.3 at best), but we CAN be
 * the best in the world at "is this kid's swing quieter and steadier than it was
 * three weeks ago", because within-hitter change cancels the pipeline's biases.
 * So the trend layer never says "you are a 74". It says "your head is 28% quieter
 * than when you started", and only when the change clears the hitter's own noise.
 *
 * Honesty gates (mirroring the EV side's MDC/PR philosophy in session.ts):
 *  - no trend at all until 2+ sessions with 3+ clean-read swings each
 *  - a change is only 'improved'/'watch' when it clears BOTH a 15% relative floor
 *    and the hitter's own swing-to-swing noise (robust MAD-based), else 'steady'
 *  - a backslide is a gentle "watch" cue, never a shame line (kid-safe voice)
 */
import type { SwingSignals } from './pose-signals.ts';

export type SessionSignals = {
  date: string; // ISO YYYY-MM-DD (session day)
  swings: Pick<SwingSignals, 'headDriftPctBh' | 'postureRangeDeg' | 'balanceOffRatio' | 'framesUsed'>[];
};

export type TrendKey = 'head' | 'posture' | 'balance';
export type TrendVerdict = 'improved' | 'steady' | 'watch';

export type TrendRead = {
  key: TrendKey;
  label: string;
  baseline: number; // session-median raw signal, first session(s)
  current: number; // session-median raw signal, latest session
  deltaPct: number; // signed relative change, negative = quieter/steadier (better)
  verdict: TrendVerdict;
  line: string; // the kid-safe sentence for the card
};

export type MechanicsTrend =
  | { ok: true; baselineDate: string; currentDate: string; sessions: number; reads: TrendRead[]; headline: string }
  | { ok: false; reason: string };

const MIN_SWINGS = 3;
const REL_FLOOR = 0.15; // a change under 15% is never called, no matter how clean
const NOISE_K = 1.6; // and it must clear ~1.6x the hitter's own robust swing-to-swing noise

/** Remote-tunable thresholds (lib/tuning.ts); the defaults are the shipped values. */
export type TrendOpts = { relFloor?: number; noiseK?: number };

const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mad = (xs: number[]): number => {
  const m = median(xs);
  return median(xs.map((x) => Math.abs(x - m)));
};

const READS: { key: TrendKey; label: string; pick: (s: SessionSignals['swings'][number]) => number }[] = [
  { key: 'head', label: 'Quiet head', pick: (s) => s.headDriftPctBh },
  { key: 'posture', label: 'Posture', pick: (s) => s.postureRangeDeg },
  { key: 'balance', label: 'Balance', pick: (s) => s.balanceOffRatio },
];

function lineFor(key: TrendKey, verdict: TrendVerdict, pct: number): string {
  const p = `${Math.abs(Math.round(pct * 100))}%`;
  if (verdict === 'improved') {
    if (key === 'head') return `Your head is ${p} quieter than your first week. Eyes on the ball, that is real progress.`;
    if (key === 'posture') return `You are holding your posture ${p} steadier through contact than when you started.`;
    return `Your balance is ${p} more centered over your base. Strong legs, strong swings.`;
  }
  if (verdict === 'watch') {
    if (key === 'head') return `Your head is moving a little more than usual lately. One quiet-eyes round will bring it back.`;
    if (key === 'posture') return `You have been standing up out of the swing a bit more lately. Hold your angle and rip it.`;
    return `You have been drifting off your base a touch lately. Stick a few finishes and it snaps back.`;
  }
  if (key === 'head') return `Your head is staying as quiet as ever. Keep it right there.`;
  if (key === 'posture') return `Posture is holding steady week to week. That repeatability is the skill.`;
  return `Balance is steady over your base, session after session. Solid.`;
}

/** Build the week-over-week mechanics trend from per-session raw signals
 *  (oldest session first). */
export function mechanicsTrend(sessions: SessionSignals[], opts: TrendOpts = {}): MechanicsTrend {
  const relFloor = opts.relFloor ?? REL_FLOOR;
  const noiseK = opts.noiseK ?? NOISE_K;
  const clean = sessions
    .map((s) => ({ ...s, swings: s.swings.filter((w) => w.framesUsed >= 4) }))
    .filter((s) => s.swings.length >= MIN_SWINGS);
  if (clean.length < 2) {
    return { ok: false, reason: 'Two sessions with a few clean swings each and the trend story starts.' };
  }

  const first = clean[0];
  const last = clean[clean.length - 1];

  const reads: TrendRead[] = READS.map(({ key, label, pick }) => {
    const baseVals = first.swings.map(pick);
    const curVals = last.swings.map(pick);
    const baseline = median(baseVals);
    const current = median(curVals);
    // pooled within-session noise, relative to the baseline level
    const noise = (mad(baseVals) + mad(curVals)) / 2;
    const scale = Math.max(baseline, 1e-6);
    const deltaPct = (current - baseline) / scale;
    const threshold = Math.max(relFloor, (noiseK * noise) / scale);

    let verdict: TrendVerdict = 'steady';
    if (deltaPct <= -threshold) verdict = 'improved'; // lower raw signal = quieter/steadier
    else if (deltaPct >= threshold) verdict = 'watch';

    return { key, label, baseline, current, deltaPct, verdict, line: lineFor(key, verdict, deltaPct) };
  });

  // headline: the biggest verified improvement wins; all-steady is its own flex
  const improved = reads.filter((r) => r.verdict === 'improved').sort((a, b) => a.deltaPct - b.deltaPct);
  const headline = improved.length
    ? improved[0].line
    : reads.some((r) => r.verdict === 'watch')
      ? `The numbers wobbled a little this stretch. Same setup, same swing, and they come right back.`
      : `Same quiet swing, week after week. Repeatable is the whole game.`;

  return {
    ok: true,
    baselineDate: first.date,
    currentDate: last.date,
    sessions: clean.length,
    reads,
    headline,
  };
}

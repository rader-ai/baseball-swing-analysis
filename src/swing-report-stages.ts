/**
 * swing-report-stages.ts — turn a graded SwingReport into the CARD-BY-CARD walk
 * (the guided "show our work" report). PURE + node-testable; zero RN imports.
 *
 * The engine measures FOUR reads (head, posture, balance, stride) across the whole
 * swing. This maps each read onto the swing STAGE where it is most legible, so we
 * can present the swing chronologically (Setup -> Load -> Contact -> Finish) without
 * ever inventing a separate per-stage score (docs/research/24, honesty wall). A
 * card's ratings ARE the report's MetricReads, just grouped by stage.
 *
 * The reference IMAGE per card (the real frame from the user's video) is fetched
 * natively at each stage's `t` and attached by the caller; this module only decides
 * WHICH reads and WHICH frame-time belong to each stage.
 */
import type { MetricKey, MetricRead, PosePhase, SwingReport } from './swing-analysis.ts';

export type StageKey = 'setup' | 'load' | 'contact' | 'finish';
export const STAGE_ORDER: StageKey[] = ['setup', 'load', 'contact', 'finish'];

export type StageCard = {
  stage: StageKey;
  label: string; // "Setup", "Load", "Contact", "Finish"
  pose?: PosePhase; // the skeleton at this stage (for the overlay), when the engine resolved it
  t?: number; // source-frame time (s) — the caller fetches the real video frame here
  imageUri?: string; // reference frame (data uri), attached by the caller from keyframesAt
  narrationPool: string; // narration pool key for this card's intro (rotating variations)
  goodText: string; // what good looks like at this stage, kid language
  ratings: MetricRead[]; // the 1-2 reads measured at this stage (real MetricReads, never fabricated)
  fixText?: string; // the actionable cue — the drill for the lowest-graded read on the card
};

type StageDef = { stage: StageKey; label: string; reads: MetricKey[]; pool: string; good: string };

// Stage -> read mapping (docs/research/24 §1): each read appears where it is most legible.
const STAGE_DEFS: StageDef[] = [
  { stage: 'setup', label: 'Setup', reads: ['posture', 'balance'], pool: 'cardSetup',
    good: 'Stand athletic and balanced, knees soft, your head over the middle of your stance.' },
  { stage: 'load', label: 'Load', reads: ['head', 'stride'], pool: 'cardLoad',
    good: 'A small, quiet gather back with your head still and level, then a soft step toward the pitcher.' },
  { stage: 'contact', label: 'Contact', reads: ['head', 'posture'], pool: 'cardContact',
    good: 'Eyes down and quiet, staying in your posture and turning around a steady spine.' },
  { stage: 'finish', label: 'Finish', reads: ['balance', 'posture'], pool: 'cardFinish',
    good: 'Balanced and in control over a firm front leg, head quiet all the way through the finish.' },
];

const GRADE_RANK = { work: 0, good: 1, great: 2 } as const;

/** Build the per-stage cards. `images` optionally maps a stage to a reference-frame data uri. */
export function stagesFromReport(report: SwingReport, images?: Partial<Record<StageKey, string>>): StageCard[] {
  const byKey = new Map<MetricKey, MetricRead>(report.metrics.map((m) => [m.key, m]));
  const poseByLabel = new Map<string, PosePhase>((report.poses ?? []).map((p) => [p.label.toLowerCase(), p]));

  return STAGE_DEFS.map((def) => {
    const ratings = def.reads.map((k) => byKey.get(k)).filter((m): m is MetricRead => !!m);
    const pose = poseByLabel.get(def.stage); // pose labels are 'Setup'/'Load'/... → lowercased match
    // the cue to chase = the drill on the lowest-graded read present on this card
    const weakest = ratings.slice().sort((a, b) => GRADE_RANK[a.grade] - GRADE_RANK[b.grade])[0];
    const fixText = weakest && weakest.grade !== 'great' ? weakest.drill?.how : undefined;
    return {
      stage: def.stage,
      label: def.label,
      pose,
      t: pose?.t,
      imageUri: images?.[def.stage],
      narrationPool: def.pool,
      goodText: def.good,
      ratings,
      fixText,
    };
  });
}

/** The stage frame-times (s) to fetch reference frames for — feed straight to keyframesAt. */
export function stageFrameTimes(report: SwingReport): { stage: StageKey; t: number }[] {
  return stagesFromReport(report)
    .filter((c): c is StageCard & { t: number } => typeof c.t === 'number')
    .map((c) => ({ stage: c.stage, t: c.t }));
}

/**
 * teaching-overlay.ts — Phase 5 (teaching overlay / "ghost" reference). The PURE,
 * honesty-safe core of the overlay: align the player's swing to the teaching phases at
 * the REAL contact frame (so a reference "ghost" can be laid over each phase), and turn
 * the unified swing into a short, prioritized coaching read.
 *
 * HONESTY + scope:
 *  - The top cue is NOT invented here — it reuses the already-validated swing-analysis
 *    rubric (docs/research/14), which is myth-free and age-aware.
 *  - Attack-angle guidance is a COACHING BAND (what coaches teach: a slightly upward
 *    path), labeled as guidance — not a measured youth norm. It is SUPPRESSED for young
 *    hitters, exactly as the rubric drops rotation grading for them (never an MLB
 *    scorecard on a 6-year-old).
 *  - The reference-ghost ART and any age-specific norm tables are deliberately left to
 *    a content pass — this module only provides the alignment + the read.
 *
 * Pure + node-tested.
 */

import { phaseIndicesFromContact } from './contact-sync.ts';
import type { AgeMode, SwingReport } from './swing-analysis.ts';

export type TeachingCue = {
  key: string;
  label: string;
  status: 'good' | 'work';
  cue: string;
  band?: string; // coaching guidance label (not a measured norm)
};

export type OverlayPhase = { label: string; idx: number }; // player frame index per teaching phase

export type TeachingOverlay = {
  topCue: TeachingCue | null; // the ONE thing to work on (from the validated rubric)
  attack: TeachingCue | null; // attack-angle coaching guidance (null for young hitters)
  phases: OverlayPhase[]; // player frames aligned to teaching phases, anchored at contact
  ageMode: AgeMode;
};

// What coaches teach: a slightly upward bat path. A BAND of guidance, not a measured norm.
const ATTACK_GOOD_LO = 5;
const ATTACK_GOOD_HI = 20;
const ATTACK_BAND = `coaches teach a slightly upward path (~+${ATTACK_GOOD_LO}° to +${ATTACK_GOOD_HI}°)`;

/**
 * Attack-angle coaching guidance. Myth-free (matches the pitch with a slight upward
 * path; never "swing down"). Returns null for young hitters — we don't coach attack
 * angle on little kids, the same way the rubric drops rotation grading for them.
 */
export function attackCue(attackDeg: number, ageMode: AgeMode): TeachingCue | null {
  if (ageMode === 'young') return null;
  const base = { key: 'attack', label: 'Attack angle', band: ATTACK_BAND };
  if (attackDeg < ATTACK_GOOD_LO) {
    return { ...base, status: 'work', cue: "You're swinging a bit flat — match the pitch with a slightly upward path and finish high." };
  }
  if (attackDeg > ATTACK_GOOD_HI) {
    return { ...base, status: 'work', cue: 'Big uppercut — flatten it a touch so you stay through the ball longer.' };
  }
  return { ...base, status: 'good', cue: 'Nice slightly-up path — right where you want it.' };
}

/**
 * Map the player's frames to the four teaching phases (Setup → Load → Contact →
 * Finish) with Contact pinned to the REAL contact frame (from the audio crack via
 * contact-sync). Dedupes when contact is near an edge. The overlay UI lays the
 * reference ghost over each returned frame.
 */
export function overlayPhases(nFrames: number, contactIdx: number): OverlayPhase[] {
  if (nFrames <= 0) return [];
  const ph = phaseIndicesFromContact(nFrames, contactIdx);
  const candidates = [
    { idx: ph.setup, label: 'Setup', prio: 1 },
    { idx: ph.load, label: 'Load', prio: 0 },
    { idx: ph.contact, label: 'Contact', prio: 3 },
    { idx: ph.finish, label: 'Finish', prio: 2 },
  ];
  const byIdx = new Map<number, { label: string; prio: number }>();
  for (const c of candidates) {
    const ex = byIdx.get(c.idx);
    if (!ex || c.prio > ex.prio) byIdx.set(c.idx, { label: c.label, prio: c.prio });
  }
  return [...byIdx.keys()].sort((a, b) => a - b).map((idx) => ({ label: byIdx.get(idx)!.label, idx }));
}

/** The rubric's single highest-priority "work on it" cue (lowest-scoring graded metric). */
function topCueFrom(report?: SwingReport): TeachingCue | null {
  if (!report) return null;
  const work = report.metrics.filter((m) => m.grade !== 'great').sort((a, b) => a.score - b.score)[0];
  if (!work) return null;
  return { key: work.key, label: work.label, status: 'work', cue: work.drill?.how ?? work.good };
}

/**
 * Build the teaching overlay: the rubric's top cue, attack-angle guidance (age-aware),
 * and the player's phase frames anchored at contact (for the ghost overlay).
 */
export function buildTeachingOverlay(input: {
  report?: SwingReport;
  attackDeg?: number;
  ageMode: AgeMode;
  nFrames?: number;
  contactIdx?: number;
}): TeachingOverlay {
  const phases =
    input.nFrames != null && input.contactIdx != null ? overlayPhases(input.nFrames, input.contactIdx) : [];
  return {
    topCue: topCueFrom(input.report),
    attack: input.attackDeg != null ? attackCue(input.attackDeg, input.ageMode) : null,
    phases,
    ageMode: input.ageMode,
  };
}

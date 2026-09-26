/**
 * contact-sync.ts — fuse the bat-crack (audio) with the video frames to pin the
 * EXACT moment of contact, and turn the crack's acoustic signature into an honest
 * contact-quality read. PURE + node-testable; ZERO capture/RN imports.
 *
 * Why this exists (docs/research/11-audio-signal.md):
 *  - The crack detector (audio-detector.ts) already stamps WHEN contact happened.
 *    This module decides WHICH video frame that is, so the pose carousel's
 *    "Contact" card and the EV window anchor to the real instant instead of an
 *    evenly-spaced guess.
 *  - It reads a rough "how flush was it" from the crack — but always flagged an
 *    ESTIMATE (the mapping is uncalibrated until we have labelled flush/mishit
 *    recordings; see readContactQuality).
 *  - It applies the audio↔vision attribution policy (§5): a crack with no matching
 *    ball is someone else's hit; a ball with no crack is lower-confidence.
 *
 * Capture-agnostic: every function takes plain timestamped frames ({ t }), so the
 * SAME logic serves the live camera path and an uploaded clip's pose frames.
 */

import type { Confidence } from './engine-types.ts';

/** Anything with a presentation time — pose frames and ball observations both qualify. */
export type TimedFrame = { t: number };

/** Just the crack fields this module needs (a subset of audio-detector's CrackEvent). */
export type CrackLike = { t: number };
export type CrackFeaturesLike = { quality: number; peakHz: number; hfLfRatio: number };

const SPEED_OF_SOUND_FTPS = 1125; // ~68°F — matches audio-detector.onsetToFrame

/** The mic hears the crack distance/c seconds AFTER contact; recover the true time. */
export function correctedContactTime(onsetTimeS: number, cameraDistanceFt: number): number {
  return onsetTimeS - cameraDistanceFt / SPEED_OF_SOUND_FTPS;
}

/** Index of the frame whose time is closest to `targetT` (-1 if no frames). Ties → earlier. */
export function nearestFrameIdx(targetT: number, frames: readonly TimedFrame[]): number {
  let best = -1;
  let bestDt = Infinity;
  for (let i = 0; i < frames.length; i++) {
    const dt = Math.abs(frames[i].t - targetT);
    if (dt < bestDt) {
      bestDt = dt;
      best = i;
    }
  }
  return best;
}

/** Median gap between consecutive frame times (frames assumed time-ordered). */
function medianSpacing(frames: readonly TimedFrame[]): number {
  if (frames.length < 2) return 0;
  const gaps: number[] = [];
  for (let i = 1; i < frames.length; i++) gaps.push(frames[i].t - frames[i - 1].t);
  gaps.sort((a, b) => a - b);
  return gaps[gaps.length >> 1] || 0;
}

export type ContactAnchor = {
  contactIdx: number; // index into `frames` nearest true contact (-1 if no frames)
  contactTimeS: number; // sound-travel-corrected contact time
  dtToFrameS: number; // |contactTime − frame.t| for the chosen frame
  source: 'audio' | 'fallback'; // audio = a real crack anchored it; fallback = heuristic
  confidence: Confidence;
};

/**
 * Pin the contact frame. With a crack: sound-travel-correct it and snap to the
 * nearest frame. Without a crack: fall back to the legacy evenly-spaced guess
 * (`fallbackFrac` of the way through), so silent/old clips behave exactly as before.
 */
export function anchorContact(opts: {
  crack?: CrackLike;
  frames: readonly TimedFrame[];
  cameraDistanceFt: number;
  fallbackFrac?: number;
}): ContactAnchor {
  const { crack, frames, cameraDistanceFt } = opts;
  const n = frames.length;

  if (!crack) {
    const frac = opts.fallbackFrac ?? 0.6;
    const idx = n ? Math.round(frac * (n - 1)) : -1;
    return {
      contactIdx: idx,
      contactTimeS: idx >= 0 ? frames[idx].t : 0,
      dtToFrameS: 0,
      source: 'fallback',
      confidence: 'low',
    };
  }

  const contactTimeS = correctedContactTime(crack.t, cameraDistanceFt);
  if (n === 0) {
    return { contactIdx: -1, contactTimeS, dtToFrameS: Infinity, source: 'audio', confidence: 'low' };
  }
  const idx = nearestFrameIdx(contactTimeS, frames);
  const dtToFrameS = Math.abs(frames[idx].t - contactTimeS);

  const first = frames[0].t;
  const last = frames[n - 1].t;
  const spacing = medianSpacing(frames);
  let confidence: Confidence;
  if (contactTimeS < first || contactTimeS > last) {
    confidence = 'low'; // contact happened outside the frames we captured — we clipped it
  } else if (contactTimeS < first + spacing || contactTimeS > last - spacing) {
    confidence = 'medium'; // landed at the very edge of capture — contact may be cut off
  } else {
    confidence = 'high';
  }
  return { contactIdx: idx, contactTimeS, dtToFrameS, source: 'audio', confidence };
}

export type PhaseIndices = { setup: number; load: number; contact: number; finish: number };

/**
 * The four carousel phase indices anchored to the REAL contact frame:
 * Setup = first frame, Contact = the anchored frame, Load = midway between them,
 * Finish = last frame. Always in-range and monotonic non-decreasing.
 */
export function phaseIndicesFromContact(nFrames: number, contactIdx: number): PhaseIndices {
  if (nFrames <= 0) return { setup: 0, load: 0, contact: 0, finish: 0 };
  const last = nFrames - 1;
  const contact = Math.max(0, Math.min(last, contactIdx));
  return {
    setup: 0,
    load: Math.round(contact / 2),
    contact,
    finish: last,
  };
}

/* ----------------------------------------------------- contact quality (sound) */

export type ContactBucket = 'flush' | 'solid' | 'mishit' | 'unknown';

export type ContactQuality = {
  score: number; // 0..1 raw flushness (echoes the crack's quality)
  bucket: ContactBucket;
  label: string; // kid-facing words
  calibrated: false; // HONESTY: this mapping is uncalibrated — always an estimate
  basis: string; // the acoustic reasoning ("ring 2600 Hz, HF-rich")
};

const BUCKET_LABEL: Record<ContactBucket, string> = {
  flush: 'Flush',
  solid: 'Solid contact',
  mishit: 'Off the barrel',
  unknown: '—',
};

/**
 * A rough "how flush was it" from the crack's sound — bucketed, never a precise
 * number. A squared-up hit rings bright (high peak freq, HF-rich); a mishit thunks
 * low and dull. `calibrated` is ALWAYS false: this is an estimate until the mapping
 * is tuned on labelled flush/mishit recordings (docs/research/11-audio-signal.md §6).
 */
export function readContactQuality(crack?: CrackFeaturesLike): ContactQuality {
  if (!crack) {
    return { score: 0, bucket: 'unknown', label: BUCKET_LABEL.unknown, calibrated: false, basis: 'no crack heard' };
  }
  const score = Math.max(0, Math.min(1, crack.quality));
  const bucket: ContactBucket = score >= 0.6 ? 'flush' : score >= 0.35 ? 'solid' : 'mishit';
  const tone = crack.hfLfRatio >= 1 ? 'HF-rich' : 'dull';
  return {
    score,
    bucket,
    label: BUCKET_LABEL[bucket],
    calibrated: false,
    basis: `ring ${Math.round(crack.peakHz)} Hz, ${tone}`,
  };
}

/* -------------------------------------------------------- audio↔vision fusion */

export type Attribution = 'confirmed' | 'crack-no-ball' | 'ball-no-crack';

export type AttributionResult = {
  verdict: Attribution;
  matched: boolean; // a crack and a ball flight co-occurred
  contactTimeS?: number; // corrected contact time when a crack was present
};

/**
 * The de-noising policy (docs/research/11-audio-signal.md §5): accept a swing only
 * when a crack AND a matching ball-flight co-occur within `matchWindowS`. A crack
 * with no ball = another hitter's swing (ignore); a ball with no crack = vision-only
 * (keep, but the caller should degrade confidence).
 */
export function attributeSwing(opts: {
  crack?: CrackLike;
  flightFrames: readonly TimedFrame[];
  matchWindowS: number;
  cameraDistanceFt: number;
}): AttributionResult {
  const { crack, flightFrames, matchWindowS, cameraDistanceFt } = opts;
  if (!crack) {
    return { verdict: 'ball-no-crack', matched: false };
  }
  const contactTimeS = correctedContactTime(crack.t, cameraDistanceFt);
  const idx = nearestFrameIdx(contactTimeS, flightFrames);
  const matched = idx >= 0 && Math.abs(flightFrames[idx].t - contactTimeS) <= matchWindowS;
  return { verdict: matched ? 'confirmed' : 'crack-no-ball', matched, contactTimeS };
}

/** A crack carrying both the timing and the spectral quality (audio-detector CrackEvent
 *  flattened to what fusion needs — same fields the native bridge emits on `onCrack`). */
export type CrackContact = { t: number; quality: number; peakHz: number; hfLfRatio: number };

/**
 * Pick the bat-ball CONTACT crack out of the cracks heard during a rep.
 *
 * Real-footage finding (docs/research/20): loudness/quality does NOT identify contact —
 * the ball hitting the (metal-framed) net ~80–110 ms after contact is consistently the
 * LOUDEST transient, a soft/foam-ball contact is the quietest (dull thunk), and pre-swing
 * taps fire too. So:
 *  - When the ball flight is tracked (vision), contact is the crack whose corrected time
 *    is nearest the ball leaving the tee — the principled, reliable anchor.
 *  - Audio-only, fall back to the EARLIEST crack (contact precedes the net ping). This is
 *    ambiguous (pre-swing taps) → callers should treat audio-only contact as low confidence.
 */
export function pickContactCrack(
  cracks: readonly CrackContact[],
  opts: { ballFlightStartT?: number; cameraDistanceFt: number },
): CrackContact | undefined {
  if (!cracks.length) return undefined;
  const corrected = (c: CrackContact) => correctedContactTime(c.t, opts.cameraDistanceFt);
  if (opts.ballFlightStartT != null) {
    const target = opts.ballFlightStartT;
    return cracks.reduce((best, c) =>
      Math.abs(corrected(c) - target) < Math.abs(corrected(best) - target) ? c : best);
  }
  return cracks.reduce((a, b) => (b.t < a.t ? b : a)); // earliest
}

/**
 * The live-path fusion seam: cracks stream in via `noteCrack`; when a vision swing
 * finalizes, `fuse` matches the most recent crack against that swing's flight frames
 * and returns its attribution + (uncalibrated) contact quality. The crack is consumed
 * so it can't bleed onto the next swing. Holds at most one crack — no growth.
 *
 * Pure and node-tested; the device path (NativeCaptureEngine) owns the I/O. It does
 * NOT touch the validated segmenter/estimator timing — this is additive metadata.
 */
export class CrackFuser {
  private latest: CrackContact | null = null;
  private readonly cameraDistanceFt: number;
  private readonly matchWindowS: number;

  constructor(opts: { cameraDistanceFt: number; matchWindowS?: number }) {
    this.cameraDistanceFt = opts.cameraDistanceFt;
    this.matchWindowS = opts.matchWindowS ?? 0.03; // ~7 frames @240fps — generous for clock skew
  }

  /** Record the latest heard crack (overwrites any unconsumed one). */
  noteCrack(c: CrackContact) {
    this.latest = c;
  }

  /** Consume the pending crack against a finished swing's flight frames. */
  fuse(flightFrames: readonly TimedFrame[]): { quality: ContactQuality; attribution: AttributionResult } {
    const crack = this.latest ?? undefined;
    const attribution = attributeSwing({
      crack,
      flightFrames,
      matchWindowS: this.matchWindowS,
      cameraDistanceFt: this.cameraDistanceFt,
    });
    const quality = readContactQuality(crack);
    this.latest = null; // consumed — don't carry it onto the next swing
    return { quality, attribution };
  }
}

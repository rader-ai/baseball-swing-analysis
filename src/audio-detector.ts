/**
 * audio-detector.ts — bat-ball CRACK detection from the mic (software-only).
 *
 * Two jobs (see docs/research/11-audio-signal.md):
 *  1. TRIGGER: detect the sharp bat-on-ball transient and stamp its time — the
 *     precise contact moment we sync to the video frames (the soft net makes no
 *     usable thud, so we key on the crack only).
 *  2. CONTACT QUALITY (exploratory): from the crack's spectrum, a first-pass
 *     "how flush was it" signal (a squared-up hit pings bright; a mishit is dull).
 *
 * MEMORY DISCIPLINE: a single fixed-size ring buffer of recent samples + fixed
 * FFT work arrays, all pre-allocated once. Steady-state per-hop allocation is
 * ~zero; nothing grows with session length. The audio buffer is read and
 * dropped — no recording is retained (privacy, same as the camera path).
 */

export type ContactFeatures = {
  centroidHz: number; // spectral centroid (brightness) — flush hits ring higher
  peakHz: number; // dominant frequency of the ring
  hfLfRatio: number; // energy >1.5 kHz / energy <1.5 kHz
  attackMs: number; // time from onset to peak amplitude (sharper = cleaner)
};

export type CrackEvent = {
  t: number; // onset time (s) — when the mic heard it (pre sound-travel correction)
  features: ContactFeatures;
  quality: number; // 0..1 exploratory "flushness" (NEEDS field calibration)
};

export type AudioConfig = {
  sampleRate: number;
  fftSize: number; // analysis window (power of 2), e.g. 512
  threshFactor: number; // HF energy must exceed floor × this to fire
  minEnergy: number; // absolute floor so silence can't trigger
  refractoryMs: number; // ignore re-triggers (the ring) this long after an onset
  floorTau: number; // EMA time-constant (s) for the adaptive noise floor
};

export const DEFAULT_AUDIO: Omit<AudioConfig, 'sampleRate'> = {
  fftSize: 512,
  threshFactor: 8,
  minEnergy: 1e-4,
  refractoryMs: 60,
  floorTau: 0.15,
};

export class AudioDetector {
  readonly cfg: AudioConfig;
  private readonly ring: Float32Array; // recent samples (for the onset window)
  private ringPos = 0;
  private ringFilled = false;
  private readonly re: Float32Array; // FFT scratch (pre-allocated)
  private readonly im: Float32Array;
  private prevSample = 0; // carry for the HF difference filter across hops
  private floor = 0; // adaptive HF-energy noise floor (EMA)
  private refractory = 0; // samples remaining in refractory
  private collecting = 0; // samples left to gather AFTER an onset before features
  private onsetT = 0; // stored onset time while collecting the post-onset window
  private t = 0; // running time (s)

  constructor(opts: Partial<AudioConfig> & { sampleRate: number }) {
    this.cfg = { ...DEFAULT_AUDIO, ...opts };
    const N = this.cfg.fftSize;
    this.ring = new Float32Array(N);
    this.re = new Float32Array(N);
    this.im = new Float32Array(N);
  }

  reset() {
    this.ringPos = 0;
    this.ringFilled = false;
    this.prevSample = 0;
    this.floor = 0;
    this.refractory = 0;
    this.collecting = 0;
    this.onsetT = 0;
    this.t = 0;
  }

  /**
   * Feed a hop of mic samples (mono, -1..1). Returns a CrackEvent if a bat
   * crack onset is detected in this hop, else null. The `hop` is not retained.
   */
  process(hop: Float32Array): CrackEvent | null {
    const { sampleRate, threshFactor, minEnergy, refractoryMs, floorTau } = this.cfg;
    const N = this.cfg.fftSize;

    // HF-emphasized short-time energy of this hop (first-difference high-pass)
    let hf = 0;
    let prev = this.prevSample;
    for (let i = 0; i < hop.length; i++) {
      const s = hop[i];
      const d = s - prev;
      hf += d * d;
      prev = s;
      // push into the ring buffer (fixed, wraps in place)
      this.ring[this.ringPos] = s;
      this.ringPos = (this.ringPos + 1) % N;
      if (this.ringPos === 0) this.ringFilled = true;
    }
    this.prevSample = prev;
    hf /= hop.length; // mean HF energy this hop
    const hopDt = hop.length / sampleRate;
    const tHop = this.t;
    this.t += hopDt;

    // After an onset, gather a full window of POST-onset audio (the crack + its
    // ring) before extracting features — otherwise we'd analyze pre-onset ambient.
    if (this.collecting > 0) {
      this.collecting -= hop.length;
      if (this.collecting <= 0) {
        this.refractory = Math.round((refractoryMs / 1000) * sampleRate);
        const features = this.features();
        return { t: this.onsetT, features, quality: this.quality(features) };
      }
      return null;
    }

    if (this.refractory > 0) {
      this.refractory -= hop.length;
      this.updateFloor(hf, hopDt, floorTau);
      return null;
    }

    const isOnset = hf > minEnergy && this.floor > 0 && hf > this.floor * threshFactor;
    if (!isOnset) {
      this.updateFloor(hf, hopDt, floorTau);
      return null;
    }

    // ONSET — start gathering the post-onset window; emit once it's full.
    this.onsetT = tHop;
    this.collecting = this.cfg.fftSize;
    return null;
  }

  /** Slow EMA noise floor; never let a transient spike pull it up fast. */
  private updateFloor(hf: number, dt: number, tau: number) {
    if (this.floor === 0) {
      this.floor = hf || 1e-9;
      return;
    }
    const a = Math.min(1, dt / tau);
    // update toward hf, but clamp upward moves so a crack doesn't inflate the floor
    const target = Math.min(hf, this.floor * 4);
    this.floor += a * (target - this.floor);
  }

  /** Spectral + time features of the current onset window. */
  private features(): ContactFeatures {
    const N = this.cfg.fftSize;
    const sr = this.cfg.sampleRate;
    // copy ring (oldest→newest) into re[], Hann-windowed; im[]=0
    let peakAmp = 0;
    let peakIdx = 0;
    for (let i = 0; i < N; i++) {
      const s = this.ring[(this.ringPos + i) % N];
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
      this.re[i] = s * w;
      this.im[i] = 0;
      const a = Math.abs(s);
      if (a > peakAmp) {
        peakAmp = a;
        peakIdx = i;
      }
    }
    fftInPlace(this.re, this.im);

    let magSum = 0;
    let fMagSum = 0;
    let lf = 0;
    let hfBand = 0;
    let peakMag = 0;
    let peakBin = 0;
    const half = N / 2;
    const binHz = sr / N;
    for (let k = 1; k < half; k++) {
      const mag = Math.hypot(this.re[k], this.im[k]);
      const f = k * binHz;
      magSum += mag;
      fMagSum += f * mag;
      if (f < 1500) lf += mag;
      else hfBand += mag;
      if (mag > peakMag) {
        peakMag = mag;
        peakBin = k;
      }
    }
    const centroidHz = magSum > 0 ? fMagSum / magSum : 0;
    const attackMs = (peakIdx / sr) * 1000;
    return {
      centroidHz,
      peakHz: peakBin * binHz,
      hfLfRatio: lf > 0 ? hfBand / lf : 0,
      attackMs,
    };
  }

  /**
   * Exploratory 0..1 "flushness": a squared-up hit rings HIGH (sharp 2–3 kHz
   * ping) with lots of high-frequency content; a mishit rings low and dull.
   * Peak-frequency + HF/LF ratio discriminate cleanly (centroid is polluted by
   * the broadband contact click, so it's reported but not scored). The mapping
   * is an ESTIMATE — must be calibrated on real flush/mishit recordings before
   * this is surfaced as a number.
   */
  private quality(f: ContactFeatures): number {
    const peak = clamp01((f.peakHz - 700) / (2800 - 700)); // ring 0.7→2.8 kHz
    const hf = clamp01(f.hfLfRatio / 6); // HF-dominant ring
    return clamp01(0.5 * peak + 0.5 * hf);
  }
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/* ----------------------------------------------- sync: audio onset → frame */

const SPEED_OF_SOUND_FTPS = 1125; // ~ at 68°F

/**
 * The mic hears the crack `distance/c` seconds AFTER contact. Correct for it and
 * return the contact time + the nearest video frame index.
 */
export function onsetToFrame(
  onsetTimeS: number,
  videoStartS: number,
  fps: number,
  cameraDistanceFt: number,
): { contactTimeS: number; frame: number } {
  const contactTimeS = onsetTimeS - cameraDistanceFt / SPEED_OF_SOUND_FTPS;
  return { contactTimeS, frame: Math.round((contactTimeS - videoStartS) * fps) };
}

/* --------------------------------------------------- compact in-place FFT */

/** Iterative radix-2 Cooley–Tukey FFT (N must be a power of 2). In place. */
function fftInPlace(re: Float32Array, im: Float32Array) {
  const n = re.length;
  // bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curR = 1;
      let curI = 0;
      for (let k = 0; k < len / 2; k++) {
        const aR = re[i + k];
        const aI = im[i + k];
        const bR = re[i + k + len / 2] * curR - im[i + k + len / 2] * curI;
        const bI = re[i + k + len / 2] * curI + im[i + k + len / 2] * curR;
        re[i + k] = aR + bR;
        im[i + k] = aI + bI;
        re[i + k + len / 2] = aR - bR;
        im[i + k + len / 2] = aI - bI;
        const nextR = curR * wr - curI * wi;
        curI = curR * wi + curI * wr;
        curR = nextR;
      }
    }
  }
}

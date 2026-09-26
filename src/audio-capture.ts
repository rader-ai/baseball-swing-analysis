/**
 * audio-capture.ts — the mic seam for bat-crack detection.
 *
 * Mirrors the camera path: a native mic source streams PCM hops in via `feed`,
 * the validated AudioDetector finds the bat-ball crack, and `onCrack` fires with
 * the contact timestamp + quality. Audio is processed live and never recorded.
 *
 * The native mic source (a streaming-PCM module, e.g. expo-audio-stream or a
 * native AVAudioEngine tap — see docs/research/11-audio-signal.md) calls
 * `feed(hop)` with mono float samples in [-1, 1]. The one integration risk is a
 * shared A/V timebase so `onsetToFrame` aligns the crack to the camera frames.
 */

import { AudioDetector, type CrackEvent } from './audio-detector.ts';

export class AudioCapture {
  private readonly detector: AudioDetector;
  private onCrack: ((e: CrackEvent) => void) | null = null;

  constructor(sampleRate = 44100) {
    this.detector = new AudioDetector({ sampleRate });
  }

  start(onCrack: (e: CrackEvent) => void) {
    this.detector.reset();
    this.onCrack = onCrack;
  }

  /** Native mic source hook — one hop of PCM samples (mono, -1..1), not retained. */
  feed(hop: Float32Array) {
    const event = this.detector.process(hop);
    if (event) this.onCrack?.(event);
  }

  stop() {
    this.onCrack = null;
  }
}

import type { FrameInput } from './detector';
import type { Detection } from './types';

/**
 * TrackNetV3 (github.com/qaz812345/TrackNetV3, MIT). The model takes a median background
 * image plus 8 consecutive frames, all RGB at 512x288 scaled to 0..1 and stacked as 27
 * channels, and returns one heatmap per frame. It needs a static camera, because the
 * background is the median over the whole clip.
 */
export const TRACKNET_WIDTH = 512;
export const TRACKNET_HEIGHT = 288;
export const TRACKNET_SEQ_LEN = 8;

/** Runs the model: Float32 input of shape (1, 27, 288, 512) to Float32 heatmaps (1, 8, 288, 512). */
export type TrackNetRunner = (input: Float32Array) => Promise<Float32Array>;

/**
 * A detector that sees a fixed-length sequence of frames at once and returns candidates for
 * every frame in it. Sequences do not overlap.
 */
export interface SequenceDetector {
  readonly id: string;
  readonly seqLen: number;
  detectSequence(frames: FrameInput[]): Promise<Detection[][]>;
}

export function isSequenceDetector(d: unknown): d is SequenceDetector {
  return typeof (d as SequenceDetector).detectSequence === 'function';
}

/** Per-pixel median of RGBA frames, returned as RGBA. Frames must share one size. */
export function medianBackground(frames: FrameInput[]): FrameInput {
  if (!frames.length) throw new Error('medianBackground needs at least one frame');
  const { width, height } = frames[0];
  const n = width * height * 4;
  const out = new Uint8ClampedArray(n);
  const k = frames.length;
  const counts = new Uint16Array(256);
  const half = Math.floor(k / 2);
  for (let i = 0; i < n; i++) {
    if ((i & 3) === 3) { out[i] = 255; continue; }
    counts.fill(0);
    for (let f = 0; f < k; f++) counts[frames[f].data[i]]++;
    // Same as numpy's median for odd k; for even k this takes the upper middle value,
    // which differs by at most one grey level.
    let acc = 0, v = 0;
    for (; v < 256; v++) { acc += counts[v]; if (acc > half) break; }
    out[i] = v;
  }
  return { data: out, width, height };
}

/** Pack background + frames into the 27-channel planar (CHW) tensor TrackNet expects. */
export function buildTrackNetInput(background: FrameInput, frames: FrameInput[], out?: Float32Array): Float32Array {
  const plane = TRACKNET_WIDTH * TRACKNET_HEIGHT;
  const all = [background, ...frames];
  const input = out ?? new Float32Array(all.length * 3 * plane);
  all.forEach((f, fi) => {
    if (f.width !== TRACKNET_WIDTH || f.height !== TRACKNET_HEIGHT) {
      throw new Error(`TrackNet frames must be ${TRACKNET_WIDTH}x${TRACKNET_HEIGHT}, got ${f.width}x${f.height}`);
    }
    const base = fi * 3 * plane;
    const d = f.data;
    for (let p = 0, i = 0; p < plane; p++, i += 4) {
      input[base + p] = d[i] / 255;
      input[base + plane + p] = d[i + 1] / 255;
      input[base + 2 * plane + p] = d[i + 2] / 255;
    }
  });
  return input;
}

/**
 * Turn one heatmap into candidates: threshold, then connected blobs, biggest first.
 * The original keeps only the biggest blob; we return a few so the tracker can choose.
 */
export function heatmapToDetections(
  heat: Float32Array, offset: number, w: number, h: number, threshold = 0.5, maxCandidates = 3,
): Detection[] {
  const n = w * h;
  const seen = new Uint8Array(n);
  const blobs: (Detection & { area: number })[] = [];
  const stack: number[] = [];
  for (let i = 0; i < n; i++) {
    if (seen[i] || heat[offset + i] <= threshold) continue;
    let area = 0, sx = 0, sy = 0, peak = 0, x0 = w, x1 = 0, y0 = h, y1 = 0;
    seen[i] = 1;
    stack.push(i);
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % w, y = (p / w) | 0;
      const v = heat[offset + p];
      area++; sx += x; sy += y; if (v > peak) peak = v;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) {
        if (q >= 0 && !seen[q] && heat[offset + q] > threshold) { seen[q] = 1; stack.push(q); }
      }
    }
    // Bounding-box centre, as in the original predict_location.
    blobs.push({ x: (x0 + x1 + 1) / 2 / w, y: (y0 + y1 + 1) / 2 / h, confidence: peak, area });
  }
  return blobs
    .sort((a, b) => b.area - a.area)
    .slice(0, maxCandidates)
    .map(({ x, y, confidence }) => ({ x, y, confidence }));
}

export interface TrackNetDetectorOptions {
  threshold?: number;
  maxCandidates?: number;
}

export class TrackNetDetector implements SequenceDetector {
  readonly id = 'tracknetv3';
  readonly seqLen = TRACKNET_SEQ_LEN;
  private buf: Float32Array;

  constructor(private run: TrackNetRunner, private background: FrameInput, private opts: TrackNetDetectorOptions = {}) {
    this.buf = new Float32Array((TRACKNET_SEQ_LEN + 1) * 3 * TRACKNET_WIDTH * TRACKNET_HEIGHT);
  }

  async detectSequence(frames: FrameInput[]): Promise<Detection[][]> {
    // Pad a short final sequence by repeating its last frame; extra outputs are dropped.
    const seq = frames.slice();
    while (seq.length < this.seqLen) seq.push(seq[seq.length - 1]);
    const heat = await this.run(buildTrackNetInput(this.background, seq, this.buf));
    const plane = TRACKNET_WIDTH * TRACKNET_HEIGHT;
    return frames.map((_, i) => heatmapToDetections(
      heat, i * plane, TRACKNET_WIDTH, TRACKNET_HEIGHT, this.opts.threshold ?? 0.5, this.opts.maxCandidates ?? 3,
    ));
  }
}

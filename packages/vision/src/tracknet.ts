import type { FrameInput } from './detector';
import type { Detection } from './types';

/**
 * TrackNetV3 (github.com/qaz812345/TrackNetV3, MIT). The model takes a median background
 * image plus 8 consecutive frames, all RGB at 512x288 scaled to 0..1 and stacked as 27
 * channels, and returns one heatmap per frame. It needs a static camera: the original
 * uses the median over the whole clip as the background. Here a clip can carry several
 * backgrounds (one per stretch of time), and each sequence uses the one it matches best,
 * so a camera that moves between still stretches still works.
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

/**
 * Median over frames of the mean absolute difference from the background (0..255).
 * A tripod clip scores a few points; a handheld clip scores 20+, and TrackNet's
 * background subtraction stops working there.
 */
export function cameraMotionScore(frames: FrameInput[], background: FrameInput): number {
  const scores = frames.map((f) => {
    let sum = 0, n = 0;
    for (let i = 0; i < f.data.length; i += 4) {
      sum += Math.abs(f.data[i] - background.data[i]) + Math.abs(f.data[i + 1] - background.data[i + 1]) + Math.abs(f.data[i + 2] - background.data[i + 2]);
      n += 3;
    }
    return n ? sum / n : 0;
  }).sort((a, b) => a - b);
  return scores.length ? scores[Math.floor(scores.length / 2)] : 0;
}

/**
 * Mean absolute RGB difference (0..255) between two frames of one size, sampling every
 * `step`-th pixel. Cheap enough to run per sequence.
 */
export function frameDifference(a: FrameInput, b: FrameInput, step = 7): number {
  let sum = 0, n = 0;
  for (let i = 0; i < a.data.length; i += 4 * step) {
    sum += Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
    n += 3;
  }
  return n ? sum / n : 0;
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
  /**
   * Skip a sequence whose frames differ from every background by more than this
   * (frameDifference, 0..255): the camera is moving and the model would fire on court
   * lines and the net tape. Still stretches measured 1-12, moving ones 18+.
   */
  maxBackgroundDifference?: number;
  /**
   * Drop a detection when its spot (a cell of 1/STILL_GRID of the frame) already had a
   * detection in this many of the last STILL_WINDOW frames. A shuttle in flight never
   * stays put; a net post, a light or a white mark the model mistakes for one does.
   */
  maxStillHits?: number;
}

const STILL_GRID = 50;
const STILL_WINDOW = 30;

export class TrackNetDetector implements SequenceDetector {
  readonly id = 'tracknetv3';
  readonly seqLen = TRACKNET_SEQ_LEN;
  /** Sequences seen, and how many were skipped for a moving camera. */
  sequences = 0;
  skipped = 0;
  private buf: Float32Array;
  private backgrounds: FrameInput[];
  /** Frame numbers of recent detections per grid cell. */
  private hits = new Map<number, number[]>();
  private frameNo = 0;

  constructor(private run: TrackNetRunner, background: FrameInput | FrameInput[], private opts: TrackNetDetectorOptions = {}) {
    this.backgrounds = Array.isArray(background) ? background : [background];
    if (!this.backgrounds.length) throw new Error('TrackNetDetector needs a background');
    this.buf = new Float32Array((TRACKNET_SEQ_LEN + 1) * 3 * TRACKNET_WIDTH * TRACKNET_HEIGHT);
  }

  async detectSequence(frames: FrameInput[]): Promise<Detection[][]> {
    this.sequences++;
    // The background the middle frame matches best.
    const mid = frames[frames.length >> 1];
    let bg = this.backgrounds[0], best = Infinity;
    if (this.backgrounds.length > 1 || this.opts.maxBackgroundDifference !== undefined) {
      for (const b of this.backgrounds) {
        const d = frameDifference(mid, b);
        if (d < best) { best = d; bg = b; }
      }
    }
    if (best > (this.opts.maxBackgroundDifference ?? Infinity)) {
      this.skipped++;
      this.frameNo += frames.length;
      return frames.map(() => []);
    }
    // Pad a short final sequence by repeating its last frame; extra outputs are dropped.
    const seq = frames.slice();
    while (seq.length < this.seqLen) seq.push(seq[seq.length - 1]);
    const heat = await this.run(buildTrackNetInput(bg, seq, this.buf));
    const plane = TRACKNET_WIDTH * TRACKNET_HEIGHT;
    return frames.map((_, i) => this.dropStill(heatmapToDetections(
      heat, i * plane, TRACKNET_WIDTH, TRACKNET_HEIGHT, this.opts.threshold ?? 0.5, this.opts.maxCandidates ?? 3,
    ), this.frameNo++));
  }

  private dropStill(dets: Detection[], frame: number): Detection[] {
    const limit = this.opts.maxStillHits;
    if (limit === undefined) return dets;
    return dets.filter((d) => {
      const cell = Math.min(STILL_GRID - 1, Math.floor(d.y * STILL_GRID)) * STILL_GRID + Math.min(STILL_GRID - 1, Math.floor(d.x * STILL_GRID));
      const recent = (this.hits.get(cell) ?? []).filter((f) => frame - f < STILL_WINDOW);
      recent.push(frame);
      this.hits.set(cell, recent);
      return recent.length <= limit;
    });
  }
}

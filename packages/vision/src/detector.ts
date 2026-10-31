import type { Detection } from './types';

/** A grayscale or RGBA frame handed to a detector. */
export interface FrameInput {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/**
 * A detector looks at a sliding window of consecutive frames and returns candidate
 * shuttle positions for the middle frame. TrackNet-style models fit this shape
 * (3 frames in, heatmap out); so does the motion placeholder below.
 */
export interface Detector {
  readonly id: string;
  /** Number of consecutive frames needed. The detection is for the middle one. */
  readonly windowSize: number;
  detect(frames: FrameInput[]): Promise<Detection[]> | Detection[];
}

function toGray(f: FrameInput): Float32Array {
  const out = new Float32Array(f.width * f.height);
  const d = f.data;
  for (let i = 0, p = 0; p < out.length; i += 4, p++) {
    out[p] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  }
  return out;
}

export interface MotionDetectorOptions {
  /** Minimum brightness change to count as motion (0..255). */
  threshold?: number;
  /** Blob area limits as a fraction of the frame area. Shuttles are small. */
  minArea?: number;
  maxArea?: number;
  maxCandidates?: number;
  /** Reject blobs whose bounding box is more elongated than this (moving limbs and edges are thin strips). */
  maxAspect?: number;
}

/**
 * Placeholder detector until the TrackNet ONNX model is in place.
 * Uses three-frame differencing: a pixel is "moving" when it differs from both the
 * previous and the next frame, then returns small moving blobs. Works on clean
 * footage with a static camera; players and rackets will produce false candidates,
 * which the tracker's gating filters out.
 */
export class MotionDetector implements Detector {
  readonly id = 'motion-3frame-v0';
  readonly windowSize = 3;
  private opts: Required<MotionDetectorOptions>;

  constructor(opts: MotionDetectorOptions = {}) {
    this.opts = {
      threshold: opts.threshold ?? 25,
      minArea: opts.minArea ?? 0.00001,
      maxArea: opts.maxArea ?? 0.0015,
      maxCandidates: opts.maxCandidates ?? 5,
      maxAspect: opts.maxAspect ?? 3,
    };
  }

  detect(frames: FrameInput[]): Detection[] {
    const [a, b, c] = frames.map(toGray);
    const { width: w, height: h } = frames[1];
    const n = w * h;
    const mask = new Uint8Array(n);
    const strength = new Float32Array(n);
    const th = this.opts.threshold;
    for (let i = 0; i < n; i++) {
      const m = Math.min(Math.abs(b[i] - a[i]), Math.abs(b[i] - c[i]));
      if (m > th) { mask[i] = 1; strength[i] = m; }
    }
    const minA = Math.max(1, this.opts.minArea * n);
    const maxA = this.opts.maxArea * n;
    const blobs: Detection[] = [];
    const stack: number[] = [];
    for (let i = 0; i < n; i++) {
      if (mask[i] !== 1) continue;
      let area = 0, sx = 0, sy = 0, sum = 0, x0 = w, x1 = 0, y0 = h, y1 = 0;
      mask[i] = 2;
      stack.push(i);
      while (stack.length) {
        const p = stack.pop()!;
        const x = p % w, y = (p / w) | 0;
        area++; sx += x; sy += y; sum += strength[p];
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (x > 0 && mask[p - 1] === 1) { mask[p - 1] = 2; stack.push(p - 1); }
        if (x < w - 1 && mask[p + 1] === 1) { mask[p + 1] = 2; stack.push(p + 1); }
        if (y > 0 && mask[p - w] === 1) { mask[p - w] = 2; stack.push(p - w); }
        if (y < h - 1 && mask[p + w] === 1) { mask[p + w] = 2; stack.push(p + w); }
      }
      if (area < minA || area > maxA) continue;
      const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      if (Math.max(bw, bh) / Math.min(bw, bh) > this.opts.maxAspect) continue;
      // Strong, consistent change in a compact blob looks like a shuttle; weak change
      // (shadows, colour edges sliding past each other) does not.
      const confidence = Math.min(1, sum / area / 255 + 0.1);
      blobs.push({ x: sx / area / w, y: sy / area / h, confidence });
    }
    return blobs.sort((p, q) => q.confidence - p.confidence).slice(0, this.opts.maxCandidates);
  }
}

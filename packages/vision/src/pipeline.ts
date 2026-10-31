import type { Detector, FrameInput } from './detector';
import { interpolateGaps, ShuttleTracker, type TrackerOptions } from './tracker';
import { segment, type SegmentOptions } from './segment';
import type { Track } from './types';

export interface FrameSource {
  /** Yields frames in presentation order with their time in seconds. */
  frames(): AsyncIterable<{ frame: FrameInput; t: number }>;
}

export interface PipelineOptions {
  detector: Detector;
  fps: number;
  width: number;
  height: number;
  sport?: string;
  tracker?: TrackerOptions;
  segment?: SegmentOptions;
  maxInterpolateGap?: number;
  onProgress?: (t: number) => void;
}

/** Run detect -> track -> interpolate -> segment over a frame source. */
export async function runPipeline(source: FrameSource, o: PipelineOptions): Promise<Track> {
  const tracker = new ShuttleTracker(o.tracker);
  const win: { frame: FrameInput; t: number }[] = [];
  const half = Math.floor(o.detector.windowSize / 2);
  let frameNo = 0;
  for await (const f of source.frames()) {
    win.push(f);
    if (win.length > o.detector.windowSize) win.shift();
    if (win.length === o.detector.windowSize) {
      const mid = win[half];
      const candidates = await o.detector.detect(win.map((w) => w.frame));
      tracker.push(frameNo - half, mid.t, candidates);
    } else if (frameNo < half) {
      // The first frames have no full window yet; record them as not visible.
      tracker.push(frameNo, f.t, []);
    }
    frameNo++;
    o.onProgress?.(f.t);
  }
  // Last frames also lack a full window.
  for (let i = win.length - half; i < win.length; i++) if (i >= 0 && win[i]) tracker.push(frameNo - (win.length - i), win[i].t, []);

  const points = interpolateGaps(tracker.points, o.maxInterpolateGap ?? 6);
  return {
    schemaVersion: 1,
    sport: o.sport ?? 'badminton',
    fps: o.fps,
    width: o.width,
    height: o.height,
    detector: o.detector.id,
    points,
    rallies: segment(points, o.fps, o.segment),
  };
}

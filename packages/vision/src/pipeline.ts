import type { Detector, FrameInput } from './detector';
import { interpolateGaps, ShuttleTracker, type TrackerOptions } from './tracker';
import { segment, type SegmentOptions } from './segment';
import type { Track } from './types';
import { isSequenceDetector, type SequenceDetector } from './tracknet';

export interface FrameSource {
  /** Yields frames in presentation order with their time in seconds. */
  frames(): AsyncIterable<{ frame: FrameInput; t: number }>;
}

export interface PipelineOptions {
  detector: Detector | SequenceDetector;
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
  if (isSequenceDetector(o.detector)) {
    await runSequences(source, o.detector, tracker, o.onProgress);
    return finish(tracker, o, o.detector.id);
  }
  const det = o.detector;
  const win: { frame: FrameInput; t: number }[] = [];
  const half = Math.floor(det.windowSize / 2);
  let frameNo = 0;
  for await (const f of source.frames()) {
    win.push(f);
    if (win.length > det.windowSize) win.shift();
    if (win.length === det.windowSize) {
      const mid = win[half];
      const candidates = await det.detect(win.map((w) => w.frame));
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

  return finish(tracker, o, det.id);
}

async function runSequences(
  source: FrameSource, det: SequenceDetector, tracker: ShuttleTracker, onProgress?: (t: number) => void,
) {
  type Item = { frame: FrameInput; t: number };
  let batch: Item[] = [];
  let frameNo = 0;
  // Inference for one sequence runs while the next sequence is being decoded.
  let pending: Promise<void> | null = null;
  const flush = () => {
    if (!batch.length) return;
    const items = batch, start = frameNo;
    batch = [];
    frameNo += items.length;
    const prev = pending;
    pending = (async () => {
      await prev; // one model run at a time, tracker updates in frame order
      const out = await det.detectSequence(items.map((b) => b.frame));
      items.forEach((b, i) => tracker.push(start + i, b.t, out[i] ?? []));
      onProgress?.(items[items.length - 1].t);
    })();
    // A failed run is rethrown by the next flush or the final await; until then it
    // must not count as an unhandled rejection.
    pending.catch(() => {});
    return prev;
  };
  for await (const f of source.frames()) {
    // Frames may reuse one buffer between yields, so keep a copy for the sequence.
    batch.push({ frame: { ...f.frame, data: new Uint8ClampedArray(f.frame.data) }, t: f.t });
    // At most one sequence waits behind the running one, so memory stays bounded.
    if (batch.length === det.seqLen) await flush();
  }
  await flush();
  await pending;
}

function finish(tracker: ShuttleTracker, o: PipelineOptions, detectorId: string): Track {
  const points = interpolateGaps(tracker.points, o.maxInterpolateGap ?? 6);
  return {
    schemaVersion: 1,
    sport: o.sport ?? 'badminton',
    fps: o.fps,
    width: o.width,
    height: o.height,
    detector: detectorId,
    points,
    rallies: segment(points, o.fps, o.segment),
  };
}

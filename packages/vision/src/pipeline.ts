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
  let batch: { frame: FrameInput; t: number }[] = [];
  let frameNo = 0;
  const flush = async () => {
    if (!batch.length) return;
    const out = await det.detectSequence(batch.map((b) => b.frame));
    batch.forEach((b, i) => tracker.push(frameNo + i, b.t, out[i] ?? []));
    frameNo += batch.length;
    onProgress?.(batch[batch.length - 1].t);
    batch = [];
  };
  for await (const f of source.frames()) {
    // Frames may reuse one buffer between yields, so keep a copy for the sequence.
    batch.push({ frame: { ...f.frame, data: new Uint8ClampedArray(f.frame.data) }, t: f.t });
    if (batch.length === det.seqLen) await flush();
  }
  await flush();
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

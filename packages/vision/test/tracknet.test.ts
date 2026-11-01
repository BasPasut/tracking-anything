import { describe, expect, it } from 'vitest';
import {
  buildTrackNetInput, heatmapToDetections, medianBackground, runPipeline, TrackNetDetector,
  TRACKNET_HEIGHT as H, TRACKNET_WIDTH as W, type FrameInput,
} from '../src';

const solid = (v: number, w = W, h = H): FrameInput => {
  const data = new Uint8ClampedArray(w * h * 4).fill(v);
  return { data, width: w, height: h };
};

describe('tracknet helpers', () => {
  it('median background ignores a value seen in a minority of frames', () => {
    const bg = medianBackground([solid(10, 4, 2), solid(10, 4, 2), solid(200, 4, 2)]);
    expect(bg.data[0]).toBe(10);
    expect(bg.data[3]).toBe(255);
  });

  it('packs background then frames as planar RGB in 0..1', () => {
    const frames = Array.from({ length: 8 }, (_, i) => solid(i * 10));
    const x = buildTrackNetInput(solid(255), frames);
    const plane = W * H;
    expect(x.length).toBe(27 * plane);
    expect(x[0]).toBe(1);
    expect(x[3 * plane]).toBe(0);
    expect(x[3 * plane * 8 + 2 * plane]).toBeCloseTo(70 / 255);
  });

  it('heatmap gives the biggest blob first, at its box centre', () => {
    const w = 20, h = 10, heat = new Float32Array(w * h);
    for (let y = 2; y < 6; y++) for (let x = 4; x < 8; x++) heat[y * w + x] = 0.9;
    heat[9 * w + 18] = 0.7;
    const d = heatmapToDetections(heat, 0, w, h);
    expect(d).toHaveLength(2);
    expect(d[0].x).toBeCloseTo(6 / w);
    expect(d[0].y).toBeCloseTo(4 / h);
    expect(d[0].confidence).toBeCloseTo(0.9);
  });
});

describe('sequence pipeline', () => {
  it('feeds 8-frame sequences and tracks the heatmap peaks', async () => {
    const n = 20, plane = W * H;
    let calls = 0;
    // Fake model: a blob moving right 6 px per frame, across every frame of the sequence.
    const run = async () => {
      const out = new Float32Array(8 * plane);
      for (let i = 0; i < 8; i++) {
        const f = calls * 8 + i, cx = 100 + f * 6, cy = 140;
        for (let y = cy - 2; y <= cy + 2; y++) for (let x = cx - 2; x <= cx + 2; x++) out[i * plane + y * W + x] = 0.95;
      }
      calls++;
      return out;
    };
    const det = new TrackNetDetector(run, solid(0));
    const source = { async *frames() { for (let i = 0; i < n; i++) yield { frame: solid(0), t: i / 30 }; } };
    const track = await runPipeline(source, { detector: det, fps: 30, width: W, height: H });
    expect(calls).toBe(3);
    expect(track.detector).toBe('tracknetv3');
    expect(track.points).toHaveLength(n);
    const vis = track.points.filter((p) => p.visible);
    expect(vis.length).toBeGreaterThan(n - 4);
    const last = vis[vis.length - 1];
    expect(last.x * W).toBeCloseTo(100 + last.frame * 6 + 0.5, 0);
  });
});

describe('court calibration and speed', () => {
  it('measures a shuttle crossing the court at a known speed', async () => {
    const { applyCourtCalibration, segment } = await import('../src');
    // Image corners = a top-down view of the court filling the frame.
    const corners = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
    const fps = 50, mps = 25; // 25 m/s = 90 km/h along the court length
    const points = Array.from({ length: 30 }, (_, i) => ({
      frame: i, t: i / fps, x: 0.5, y: (i / fps) * mps / 13.4, visible: true, confidence: 1, interpolated: false,
    }));
    const track = { schemaVersion: 1 as const, sport: 'badminton', fps, width: 610, height: 1340, detector: 't', points, rallies: segment(points, fps) };
    const out = applyCourtCalibration(track, corners);
    expect(out.points[10].courtX).toBeCloseTo(3.05);
    expect(out.points[10].speedKmh).toBeCloseTo(90, 0);
    expect(out.rallies[0].shots[0].initialSpeedKmh).toBeCloseTo(90, 0);
  });
});

describe('camera motion score', () => {
  it('is near zero for a still background and high when the picture shifts', async () => {
    const { cameraMotionScore } = await import('../src');
    const bg = solid(100, 8, 8);
    expect(cameraMotionScore([solid(100, 8, 8), solid(102, 8, 8), solid(100, 8, 8)], bg)).toBeLessThan(2);
    expect(cameraMotionScore([solid(160, 8, 8), solid(40, 8, 8), solid(150, 8, 8)], bg)).toBeGreaterThan(40);
  });
});

describe('several backgrounds', () => {
  it('uses the background the frames match and skips frames that match none', async () => {
    const seen: number[] = [];
    // Fake model: remembers the background brightness it was given.
    const run = async (x: Float32Array) => { seen.push(Math.round(x[0] * 255)); return new Float32Array(8 * W * H); };
    const det = new TrackNetDetector(run, [solid(20), solid(200)], { maxBackgroundDifference: 16 });
    await det.detectSequence(Array.from({ length: 8 }, () => solid(195)));
    expect(seen).toEqual([200]);
    const out = await det.detectSequence(Array.from({ length: 8 }, () => solid(110)));
    expect(out).toHaveLength(8);
    expect(out.every((d) => d.length === 0)).toBe(true);
    expect(seen).toHaveLength(1);
    expect([det.sequences, det.skipped]).toEqual([2, 1]);
  });
});

describe('still detections', () => {
  it('drops a spot that keeps firing but keeps a moving one', async () => {
    // Fake model: a blob at a fixed spot in every frame, plus one that moves.
    let call = 0;
    const run = async () => {
      const heat = new Float32Array(8 * W * H);
      for (let i = 0; i < 8; i++) {
        const f = call * 8 + i;
        for (const [x, y] of [[100, 100], [20 + f * 10, 200]]) heat[i * W * H + y * W + x] = 0.9;
      }
      call++;
      return heat;
    };
    const det = new TrackNetDetector(run, solid(0), { maxStillHits: 10 });
    const frames = Array.from({ length: 8 }, () => solid(0));
    const out = [...await det.detectSequence(frames), ...await det.detectSequence(frames)];
    const still = (d: { y: number }[]) => d.some((p) => Math.abs(p.y - 100.5 / H) < 0.01);
    expect(out.slice(0, 10).every(still)).toBe(true);
    expect(out.slice(10).some(still)).toBe(false);
    expect(out.every((d) => d.some((p) => !still([p])))).toBe(true);
  });
});

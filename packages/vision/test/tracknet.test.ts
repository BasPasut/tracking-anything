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

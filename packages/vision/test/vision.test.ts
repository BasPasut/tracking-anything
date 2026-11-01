import { describe, expect, it } from 'vitest';
import {
  applyHomography, badmintonCourtCorners, computeHomography, interpolateGaps, MotionDetector,
  runPipeline, segment, ShuttleTracker, trackToCsv, type FrameInput, type TrackPoint,
} from '../src';

const fps = 60;

/** Synthetic rally: shuttle goes right-up then comes back left after a "hit" at frame 40. */
function rallyPath(n = 80) {
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    if (i < 40) pts.push({ x: 0.2 + i * 0.01, y: 0.7 - i * 0.008 + (i * i) * 0.0001 });
    else { const j = i - 40; pts.push({ x: 0.6 - j * 0.01, y: 0.54 - j * 0.006 + j * j * 0.0002 }); }
  }
  return pts;
}

describe('tracker', () => {
  it('follows the shuttle and ignores far-away noise', () => {
    const tr = new ShuttleTracker();
    rallyPath().forEach((p, i) => {
      const noise = i % 7 === 0 ? [{ x: 0.95, y: 0.05, confidence: 0.9 }] : [];
      tr.push(i, i / fps, [{ ...p, confidence: 0.8 }, ...noise]);
    });
    const far = tr.points.filter((p) => p.visible && p.x > 0.9);
    expect(far).toHaveLength(0);
    expect(tr.points.filter((p) => p.visible).length).toBeGreaterThanOrEqual(79);
  });

  it('switches from a slow false lock to the shuttle in flight', () => {
    const tr = new ShuttleTracker();
    const path = rallyPath();
    for (let i = 0; i < 80; i++) {
      // A jittering artefact (e.g. a player edge crossing a court line) visible the whole time.
      const cands = [{ x: 0.5 + (i % 3) * 0.002, y: 0.83, confidence: 0.9 }];
      if (i >= 20) cands.push({ ...path[i], confidence: 0.6 });
      tr.push(i, i / fps, cands);
    }
    const late = tr.points.slice(30).filter((p) => p.visible);
    expect(late.length).toBeGreaterThan(45);
    expect(late.every((p) => Math.abs(p.y - 0.83) > 0.02)).toBe(true);
  });

  it('fills short gaps and leaves long ones', () => {
    const mk = (frame: number, visible: boolean): TrackPoint => ({ frame, t: frame / fps, x: visible ? frame / 100 : NaN, y: 0.5, visible, confidence: visible ? 1 : 0, interpolated: false });
    const pts = [mk(0, true), mk(1, false), mk(2, false), mk(3, true), ...Array.from({ length: 10 }, (_, i) => mk(4 + i, false)), mk(14, true)];
    const out = interpolateGaps(pts, 6);
    expect(out[1].interpolated && out[2].interpolated).toBe(true);
    expect(out[1].x).toBeCloseTo(0.01);
    expect(out[5].visible).toBe(false);
  });
});

describe('segment', () => {
  it('finds one rally with two shots split at the hit', () => {
    const pts: TrackPoint[] = rallyPath().map((p, i) => ({ frame: i, t: i / fps, ...p, visible: true, confidence: 1, interpolated: false }));
    const rallies = segment(pts, fps);
    expect(rallies).toHaveLength(1);
    expect(rallies[0].shots).toHaveLength(2);
    expect(Math.abs(rallies[0].shots[1].startFrame - 40)).toBeLessThanOrEqual(2);
  });

  it('splits rallies on a long gap', () => {
    const vis = (i: number) => i < 60 || i >= 160;
    const pts: TrackPoint[] = Array.from({ length: 220 }, (_, i) => ({ frame: i, t: i / fps, x: vis(i) ? 0.1 + (i % 60) * 0.01 : NaN, y: 0.5, visible: vis(i), confidence: 1, interpolated: false }));
    expect(segment(pts, fps)).toHaveLength(2);
  });
});

describe('homography', () => {
  it('maps court corners exactly and the centre sensibly', () => {
    const img = [{ x: 0.3, y: 0.2 }, { x: 0.7, y: 0.2 }, { x: 0.9, y: 0.9 }, { x: 0.1, y: 0.9 }];
    const H = computeHomography(img, badmintonCourtCorners());
    badmintonCourtCorners().forEach((c, i) => {
      const m = applyHomography(H, img[i]);
      expect(m.x).toBeCloseTo(c.x, 6);
      expect(m.y).toBeCloseTo(c.y, 6);
    });
    expect(applyHomography(H, { x: 0.5, y: 0.5 }).x).toBeCloseTo(3.05, 3);
  });
});

describe('motion detector + pipeline', () => {
  it('detects a small moving dot on a static background', async () => {
    const W = 320, H = 180;
    const path = rallyPath(60);
    const frame = (i: number): FrameInput => {
      const data = new Uint8ClampedArray(W * H * 4).fill(40);
      const cx = Math.round(path[i].x * W), cy = Math.round(path[i].y * H);
      for (let y = cy - 1; y <= cy + 1; y++) for (let x = cx - 1; x <= cx + 1; x++) {
        const k = (y * W + x) * 4; data[k] = data[k + 1] = data[k + 2] = 255;
      }
      return { data, width: W, height: H };
    };
    const source = { async *frames() { for (let i = 0; i < path.length; i++) yield { frame: frame(i), t: i / fps }; } };
    const track = await runPipeline(source, { detector: new MotionDetector(), fps, width: 1920, height: 1080 });
    expect(track.points).toHaveLength(60);
    track.points.forEach((p, i) => expect(p.frame).toBe(i));
    const seen = track.points.filter((p) => p.visible && !p.interpolated);
    expect(seen.length).toBeGreaterThan(50);
    const p = track.points[30];
    expect(Math.abs(p.x - path[30].x)).toBeLessThan(0.02);
    const csv = trackToCsv(track);
    expect(csv.split('\n')[0]).toContain('frame,time_s');
    expect(csv.trim().split('\n')).toHaveLength(61);
  });
});

describe('motion detector shape filter', () => {
  it('ignores a thin moving edge but keeps a compact blob', () => {
    const W = 200, H = 100;
    const frame = (i: number): FrameInput => {
      const data = new Uint8ClampedArray(W * H * 4).fill(40);
      const paint = (x: number, y: number) => { const k = (y * W + x) * 4; data[k] = data[k + 1] = data[k + 2] = 255; };
      // A tall block sliding right by 2px per frame: its diff is a 2px x 40px strip.
      for (let y = 30; y < 70; y++) for (let x = 20 + i * 2; x < 40 + i * 2; x++) paint(x, y);
      // A 4x4 shuttle jumping 8px per frame.
      for (let y = 10; y < 14; y++) for (let x = 100 + i * 8; x < 104 + i * 8; x++) paint(x, y);
      return { data, width: W, height: H };
    };
    const found = new MotionDetector().detect([frame(0), frame(1), frame(2)]);
    expect(found).toHaveLength(1);
    expect(found[0].y).toBeCloseTo(11.5 / H, 2);
  });
});

describe('renderOverlay', () => {
  it('draws only the most recent shots of a long rally', async () => {
    const { renderOverlay, defaultStyle } = await import('../src');
    const pts: TrackPoint[] = rallyPath().map((p, i) => ({ frame: i, t: i / fps, ...p, visible: true, confidence: 1, interpolated: false }));
    const track = {
      schemaVersion: 1 as const, sport: 'badminton', fps, width: 100, height: 100, detector: 'test', points: pts,
      rallies: [{ index: 0, startFrame: 0, endFrame: 79, shots: [0, 1, 2, 3].map((k) => ({ index: k, startIdx: k * 20, endIdx: k * 20 + 19, startFrame: k * 20, endFrame: k * 20 + 19, apexIdx: k * 20 })) }],
    };
    const moves: number[][] = [];
    const ctx = new Proxy({}, {
      get: (_t, prop) => prop === 'moveTo' ? (x: number, y: number) => moves.push([x, y]) : () => {},
      set: () => true,
    }) as unknown as CanvasRenderingContext2D;
    renderOverlay(ctx, track, 79 / fps, 100, 100, { ...defaultStyle, trailFrames: 0, showMarkers: false, recentShots: 2, showHud: false, showLockOn: false });
    // Shot paths start at their first point: only shots 2 and 3 should be drawn.
    expect(moves.map(([x]) => Math.round(x))).toEqual([Math.round(pts[40].x * 100), Math.round(pts[60].x * 100)]);
  });
});

describe('hudState', () => {
  it('counts shots and rally time in a live rally, freezes after it ends', async () => {
    const { hudState } = await import('../src');
    const pts: TrackPoint[] = Array.from({ length: 100 }, (_, i) => ({ frame: i, t: i / 10, x: 0.5, y: 0.5, visible: i < 60, confidence: 1, interpolated: false }));
    const track = {
      schemaVersion: 1 as const, sport: 'badminton', fps: 10, width: 100, height: 100, detector: 'test', points: pts,
      rallies: [{ index: 0, startFrame: 10, endFrame: 59, shots: [
        { index: 0, startIdx: 10, endIdx: 30, startFrame: 10, endFrame: 30, apexIdx: 20, initialSpeedKmh: 120 },
        { index: 1, startIdx: 30, endIdx: 59, startFrame: 30, endFrame: 59, apexIdx: 40, initialSpeedKmh: 250 },
      ] }],
    };
    const live = hudState(track, 35, 3.5);
    expect(live).toMatchObject({ shotCount: 2, speedKmh: 250, live: true });
    expect(live.rallyTime).toBeCloseTo(2.5);
    const after = hudState(track, 80, 8);
    expect(after).toMatchObject({ shotCount: 2, speedKmh: undefined, live: false });
    expect(after.rallyTime).toBeCloseTo(4.9);
  });
});

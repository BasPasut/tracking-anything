import type { Rally, Shot, TrackPoint } from './types';

export interface SegmentOptions {
  /** A gap with no visible shuttle longer than this (seconds) ends a rally. */
  rallyGapSec?: number;
  /** Frames used on each side to measure direction. */
  window?: number;
  /** Direction change (degrees) that counts as a hit. */
  hitAngleDeg?: number;
  /** Minimum frames between two hits. */
  minShotFrames?: number;
  /** Rallies shorter than this many visible frames are dropped as noise. */
  minRallyFrames?: number;
}

function angleBetween(ax: number, ay: number, bx: number, by: number): number {
  const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
  if (la < 1e-6 || lb < 1e-6) return 0;
  const c = Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb)));
  return (Math.acos(c) * 180) / Math.PI;
}

/** Split a track into rallies (continuous flight) and each rally into shots (hit to hit). */
export function segment(points: TrackPoint[], fps: number, opts: SegmentOptions = {}): Rally[] {
  const o = {
    rallyGapSec: opts.rallyGapSec ?? 1,
    window: opts.window ?? 3,
    hitAngleDeg: opts.hitAngleDeg ?? 100,
    minShotFrames: opts.minShotFrames ?? Math.round(fps * 0.25),
    minRallyFrames: opts.minRallyFrames ?? Math.round(fps * 0.5),
  };
  const maxGap = Math.max(1, Math.round(o.rallyGapSec * fps));

  // 1. Find runs of visible points, merging runs separated by short gaps.
  const runs: Array<[number, number]> = [];
  let start = -1, lastVisible = -1;
  for (let i = 0; i < points.length; i++) {
    if (!points[i].visible) continue;
    if (start < 0) start = i;
    else if (i - lastVisible > maxGap) { runs.push([start, lastVisible]); start = i; }
    lastVisible = i;
  }
  if (start >= 0) runs.push([start, lastVisible]);

  const rallies: Rally[] = [];
  for (const [s, e] of runs) {
    const idx: number[] = [];
    for (let i = s; i <= e; i++) if (points[i].visible) idx.push(i);
    if (idx.length < o.minRallyFrames) continue;

    // 2. Hits = local maxima of direction change along the visible points.
    const w = o.window;
    const angles = idx.map((_, k) => {
      if (k < w || k + w >= idx.length) return 0;
      const p = points[idx[k]], a = points[idx[k - w]], b = points[idx[k + w]];
      return angleBetween(p.x - a.x, p.y - a.y, b.x - p.x, b.y - p.y);
    });
    const hits: number[] = [0];
    for (let k = 1; k < idx.length - 1; k++) {
      if (angles[k] < o.hitAngleDeg) continue;
      if (angles[k] < angles[k - 1] || angles[k] < angles[k + 1]) continue;
      const prev = hits[hits.length - 1];
      if (points[idx[k]].frame - points[idx[prev]].frame < o.minShotFrames) {
        if (prev !== 0 && angles[k] > angles[prev]) hits[hits.length - 1] = k;
        continue;
      }
      hits.push(k);
    }
    hits.push(idx.length - 1);

    const shots: Shot[] = [];
    for (let h = 0; h < hits.length - 1; h++) {
      const a = idx[hits[h]], b = idx[hits[h + 1]];
      let apex = a;
      for (let i = a; i <= b; i++) if (points[i].visible && points[i].y < points[apex].y) apex = i;
      shots.push({ index: shots.length, startIdx: a, endIdx: b, startFrame: points[a].frame, endFrame: points[b].frame, apexIdx: apex });
    }
    rallies.push({ index: rallies.length, startFrame: points[s].frame, endFrame: points[e].frame, shots });
  }
  return rallies;
}

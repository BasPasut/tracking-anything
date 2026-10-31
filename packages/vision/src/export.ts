import type { Track } from './types';

const fmt = (n: number | undefined, d = 5) => (n === undefined || Number.isNaN(n) ? '' : n.toFixed(d));

/** Per-frame CSV. Pixel columns use the source video size. */
export function trackToCsv(track: Track): string {
  const shotOf = new Map<number, [number, number]>();
  for (const r of track.rallies) for (const s of r.shots) for (let i = s.startIdx; i <= s.endIdx; i++) shotOf.set(i, [r.index, s.index]);
  const head = 'frame,time_s,x_px,y_px,x_norm,y_norm,visible,interpolated,confidence,rally,shot,court_x_m,court_y_m';
  const rows = track.points.map((p, i) => {
    const rs = shotOf.get(i);
    return [
      p.frame, p.t.toFixed(4),
      fmt(p.x * track.width, 1), fmt(p.y * track.height, 1), fmt(p.x), fmt(p.y),
      p.visible ? 1 : 0, p.interpolated ? 1 : 0, p.confidence.toFixed(3),
      rs ? rs[0] : '', rs ? rs[1] : '', fmt(p.courtX, 3), fmt(p.courtY, 3),
    ].join(',');
  });
  return [head, ...rows].join('\n') + '\n';
}

export function trackToJson(track: Track): string {
  return JSON.stringify(track, (_k, v) => (typeof v === 'number' && Number.isNaN(v) ? null : v));
}

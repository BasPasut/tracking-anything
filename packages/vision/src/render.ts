import type { Track, TrackPoint } from './types';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface OverlayStyle {
  /** Fading comet tail length in frames. 0 hides it. */
  trailFrames: number;
  /** Draw the whole current shot's path up to now. */
  showShotPath: boolean;
  /** Mark hit, apex and landing points of finished shots in the current rally. */
  showMarkers: boolean;
  /** Line width as a fraction of the frame height. */
  lineWidth: number;
  /** Colours cycled per shot. */
  palette: string[];
}

export const defaultStyle: OverlayStyle = {
  trailFrames: 20,
  showShotPath: true,
  showMarkers: true,
  lineWidth: 0.006,
  palette: ['#ffd60a', '#00e5ff', '#ff4d6d', '#7cff6b', '#c77dff'],
};

/** Index of the last point whose time is <= t (binary search). */
export function indexAtTime(points: TrackPoint[], t: number): number {
  let lo = 0, hi = points.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= t + 1e-6) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

function strokeRun(ctx: Ctx, pts: TrackPoint[], from: number, to: number, w: number, h: number) {
  let open = false;
  ctx.beginPath();
  for (let i = from; i <= to; i++) {
    const p = pts[i];
    if (!p.visible) { open = false; continue; }
    if (!open) { ctx.moveTo(p.x * w, p.y * h); open = true; } else ctx.lineTo(p.x * w, p.y * h);
  }
  ctx.stroke();
}

/**
 * Draw the trajectory overlay for time `t` onto a context sized w x h.
 * The same function is used for the live preview and for MP4 export, so what the
 * user sees is what gets exported.
 */
export function renderOverlay(ctx: Ctx, track: Track, t: number, w: number, h: number, style: OverlayStyle = defaultStyle) {
  const pts = track.points;
  const now = indexAtTime(pts, t);
  if (now < 0) return;
  const lw = Math.max(2, style.lineWidth * h);
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const rally = track.rallies.find((r) => pts[now].frame >= r.startFrame && pts[now].frame <= r.endFrame + 1);
  if (rally) {
    for (const s of rally.shots) {
      if (s.startIdx > now) break;
      const colour = style.palette[s.index % style.palette.length];
      const end = Math.min(s.endIdx, now);
      if (style.showShotPath) {
        ctx.strokeStyle = colour;
        ctx.globalAlpha = s.endIdx < now ? 0.45 : 0.9;
        ctx.lineWidth = lw * 0.6;
        strokeRun(ctx, pts, s.startIdx, end, w, h);
      }
      if (style.showMarkers) {
        ctx.globalAlpha = 1;
        const hit = pts[s.startIdx];
        marker(ctx, hit.x * w, hit.y * h, lw * 1.6, colour, 'ring');
        if (s.apexIdx <= now) { const a = pts[s.apexIdx]; marker(ctx, a.x * w, a.y * h, lw * 1.1, colour, 'dot'); }
        if (s.endIdx <= now) { const e = pts[s.endIdx]; marker(ctx, e.x * w, e.y * h, lw * 1.8, colour, 'cross'); }
      }
    }
  }

  if (style.trailFrames > 0) {
    const from = Math.max(0, now - style.trailFrames);
    for (let i = from + 1; i <= now; i++) {
      const a = pts[i - 1], b = pts[i];
      if (!a.visible || !b.visible) continue;
      const f = (i - from) / (now - from + 1);
      ctx.globalAlpha = f;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = lw * (0.4 + f);
      ctx.beginPath();
      ctx.moveTo(a.x * w, a.y * h);
      ctx.lineTo(b.x * w, b.y * h);
      ctx.stroke();
    }
    const p = pts[now];
    if (p.visible) {
      ctx.globalAlpha = 1;
      marker(ctx, p.x * w, p.y * h, lw * 1.2, '#ffffff', 'dot');
    }
  }
  ctx.restore();
}

function marker(ctx: Ctx, x: number, y: number, r: number, colour: string, kind: 'dot' | 'ring' | 'cross') {
  ctx.strokeStyle = colour;
  ctx.fillStyle = colour;
  ctx.lineWidth = Math.max(1.5, r * 0.35);
  ctx.beginPath();
  if (kind === 'dot') { ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); }
  else if (kind === 'ring') { ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke(); }
  else { ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r); ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r); ctx.stroke(); }
}

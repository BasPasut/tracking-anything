import type { Track, TrackPoint } from './types';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface OverlayStyle {
  /** Fading comet tail length in frames. 0 hides it. */
  trailFrames: number;
  /** Draw the whole current shot's path up to now. */
  showShotPath: boolean;
  /** Mark hit, apex and landing points of finished shots in the current rally. */
  showMarkers: boolean;
  /** How many shots of the current rally stay drawn (the current one included). Older ones fade out. */
  recentShots: number;
  /** Show the current shot's speed (needs a court calibration). */
  showSpeed: boolean;
  /** Line width as a fraction of the frame height. */
  lineWidth: number;
  /** Colours cycled per shot. */
  palette: string[];
}

export const defaultStyle: OverlayStyle = {
  trailFrames: 20,
  showShotPath: true,
  showMarkers: true,
  recentShots: 2,
  showSpeed: true,
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

  let speedLabel: { text: string; colour: string } | null = null;
  const rally = track.rallies.find((r) => pts[now].frame >= r.startFrame && pts[now].frame <= r.endFrame + 1);
  if (rally) {
    let current = 0;
    for (const s of rally.shots) if (s.startIdx <= now) current = s.index;
    const cur = rally.shots[current];
    if (cur && style.showSpeed && cur.initialSpeedKmh !== undefined && cur.startIdx <= now) {
      speedLabel = { text: `SHOT ${current + 1}  ${Math.round(cur.initialSpeedKmh)} km/h`, colour: style.palette[current % style.palette.length] };
    }
    for (const s of rally.shots) {
      if (s.startIdx > now) break;
      if (s.index <= current - Math.max(1, style.recentShots)) continue;
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
  if (speedLabel) drawLabel(ctx, speedLabel.text, speedLabel.colour, w, h);
  ctx.restore();
}

/** Speed pill in the top-left corner, sized to the frame. */
function drawLabel(ctx: Ctx, text: string, colour: string, w: number, h: number) {
  const size = Math.max(14, Math.round(h * 0.045));
  const pad = size * 0.5, x = Math.round(w * 0.03), y = Math.round(h * 0.04);
  ctx.globalAlpha = 1;
  ctx.font = `700 ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.textBaseline = 'middle';
  const tw = ctx.measureText(text).width;
  const bh = size + pad * 1.2;
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.beginPath();
  ctx.roundRect(x, y, tw + pad * 2 + size * 0.6, bh, bh / 2);
  ctx.fill();
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.arc(x + pad + size * 0.2, y + bh / 2, size * 0.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, x + pad + size * 0.6, y + bh / 2);
}

/** Court outline from tapped corners (normalized), drawn while calibrating and after. */
export function renderCourt(ctx: Ctx, corners: { x: number; y: number }[], w: number, h: number) {
  if (!corners.length) return;
  const r = Math.max(5, h * 0.012);
  ctx.save();
  ctx.strokeStyle = '#00e5ff';
  ctx.fillStyle = '#00e5ff';
  ctx.lineWidth = Math.max(2, h * 0.004);
  ctx.setLineDash([r * 1.5, r]);
  ctx.beginPath();
  corners.forEach((c, i) => (i ? ctx.lineTo(c.x * w, c.y * h) : ctx.moveTo(c.x * w, c.y * h)));
  if (corners.length === 4) ctx.closePath();
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.font = `700 ${Math.round(r * 2.2)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  corners.forEach((c, i) => {
    ctx.fillStyle = '#00e5ff';
    ctx.beginPath(); ctx.arc(c.x * w, c.y * h, r * 1.6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#000';
    ctx.fillText(String(i + 1), c.x * w, c.y * h);
  });
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

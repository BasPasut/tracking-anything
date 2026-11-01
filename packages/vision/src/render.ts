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
  /** Show shot speed on the lock-on tag and in the HUD (needs a court calibration). */
  showSpeed: boolean;
  /** Broadcast-style bar at the top: rally time, shot count, shot speed. */
  showHud: boolean;
  /** Reticle and tag on the shuttle. */
  showLockOn: boolean;
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
  showHud: true,
  showLockOn: true,
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
    let current = 0;
    for (const s of rally.shots) if (s.startIdx <= now) current = s.index;

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
    if (p.visible && !style.showLockOn) {
      ctx.globalAlpha = 1;
      marker(ctx, p.x * w, p.y * h, lw * 1.2, '#ffffff', 'dot');
    }
  }

  const hud = hudState(track, now, t);
  const speed = style.showSpeed ? hud.speedKmh : undefined;
  const hudBottom = style.showHud ? drawHud(ctx, w, h, hud.rallyTime, hud.shotCount, speed) : 0;
  // Lock on only inside a rally: lone detections outside one are usually false.
  if (style.showLockOn && hud.live && pts[now].visible) drawLockOn(ctx, pts[now].x * w, pts[now].y * h, w, h, speed, hudBottom);
  ctx.restore();
}

/** What the HUD shows at frame `now`: the current rally, or the last one that ended. */
export function hudState(track: Track, now: number, t: number) {
  const pts = track.points;
  const frame = pts[now]?.frame ?? 0;
  let rally = track.rallies.find((r) => frame >= r.startFrame && frame <= r.endFrame);
  const live = !!rally;
  if (!rally) rally = [...track.rallies].reverse().find((r) => r.endFrame < frame);
  if (!rally) return { rallyTime: 0, shotCount: 0, speedKmh: undefined as number | undefined, live };
  const startT = pts[rally.shots[0]?.startIdx ?? 0]?.t ?? 0;
  const lastShot = rally.shots[rally.shots.length - 1];
  const endT = live ? t : pts[lastShot?.endIdx ?? 0]?.t ?? t;
  let cur = rally.shots[0];
  for (const s of rally.shots) if (s.startIdx <= now) cur = s;
  return {
    rallyTime: Math.max(0, endT - startT),
    shotCount: live ? (cur ? cur.index + 1 : 0) : rally.shots.length,
    speedKmh: live ? cur?.initialSpeedKmh : undefined,
    live,
  };
}

const HUD_BG = 'rgba(10, 22, 40, 0.82)';
const HUD_FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';

function fmtTime(sec: number) {
  const m = Math.floor(sec / 60), s = sec - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

/** Three panels across the top, like a broadcast score bug. Returns the bar's bottom edge. */
function drawHud(ctx: Ctx, w: number, h: number, rallyTime: number, shots: number, speed: number | undefined): number {
  const unit = Math.min(w, h * 1.2);
  const margin = Math.round(w * 0.02), gap = Math.round(unit * 0.012);
  const ph = Math.round(unit * 0.1), top = Math.round(h * 0.03);
  // On wide frames the bar stays compact in the top-left instead of spanning the width.
  const total = Math.min(w - margin * 2, unit * 0.95);
  const panelW = (total - gap * 2) / 3;
  const panels: { label: string; value: string; unit?: string; accent: string }[] = [
    { label: 'RALLY TIME', value: fmtTime(rallyTime), accent: '#00e5ff' },
    { label: 'RALLY COUNT', value: String(shots), unit: 'SHOT', accent: '#ffd60a' },
    { label: 'SHOT SPEED', value: speed === undefined ? '--' : String(Math.round(speed)), unit: 'km/h', accent: '#ff4d6d' },
  ];
  ctx.globalAlpha = 1;
  ctx.textBaseline = 'alphabetic';
  panels.forEach((p, i) => {
    const x = margin + i * (panelW + gap);
    ctx.fillStyle = HUD_BG;
    ctx.fillRect(x, top, panelW, ph);
    ctx.fillStyle = p.accent;
    ctx.fillRect(x, top, Math.max(2, unit * 0.005), ph);
    ctx.fillStyle = p.accent;
    ctx.font = `600 ${Math.round(ph * 0.17)}px ${HUD_FONT}`;
    ctx.textAlign = 'left';
    ctx.fillText(p.label, x + ph * 0.18, top + ph * 0.28);
    ctx.fillStyle = '#ffffff';
    ctx.font = `700 ${Math.round(ph * 0.5)}px ${HUD_FONT}`;
    ctx.fillText(p.value, x + ph * 0.18, top + ph * 0.82);
    if (p.unit) {
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.font = `600 ${Math.round(ph * 0.16)}px ${HUD_FONT}`;
      ctx.textAlign = 'right';
      ctx.fillText(p.unit, x + panelW - ph * 0.12, top + ph * 0.82);
    }
  });
  return top + ph;
}

/** Corner-bracket reticle on the shuttle with a "LOCK ON" tag. */
function drawLockOn(ctx: Ctx, x: number, y: number, w: number, h: number, speed: number | undefined, minY = 0) {
  const unit = Math.min(w, h * 1.2);
  const r = unit * 0.03, k = r * 0.45;
  ctx.globalAlpha = 1;
  ctx.strokeStyle = '#ffd60a';
  ctx.lineWidth = Math.max(1.5, unit * 0.004);
  ctx.beginPath();
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    ctx.moveTo(x + sx * r, y + sy * (r - k));
    ctx.lineTo(x + sx * r, y + sy * r);
    ctx.lineTo(x + sx * (r - k), y + sy * r);
  }
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, r * 0.35, 0, Math.PI * 2);
  ctx.stroke();

  const fs = Math.round(unit * 0.026);
  const line1 = 'LOCK ON', line2 = speed === undefined ? '' : `${Math.round(speed)} km/h`;
  ctx.font = `700 ${fs}px ${HUD_FONT}`;
  const tw = Math.max(ctx.measureText(line2).width, fs * 3.2);
  const bw = tw + fs * 0.8, bh = line2 ? fs * 2.3 : fs * 1.3;
  // Tag sits up-right of the reticle; it flips below or left to stay clear of the HUD and the frame edge.
  const tx = x + r * 1.3 + bw > w ? x - r * 1.3 - bw : x + r * 1.3;
  let ty = y - r * 1.4;
  if (ty - bh < minY + fs * 0.3) ty = y + r * 1.4 + bh;
  ctx.fillStyle = HUD_BG;
  ctx.fillRect(tx, ty - bh, bw, bh);
  ctx.fillStyle = '#ffd60a';
  ctx.fillRect(tx, ty - bh, Math.max(2, unit * 0.004), bh);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = `600 ${Math.round(fs * 0.6)}px ${HUD_FONT}`;
  ctx.fillStyle = '#ffd60a';
  ctx.fillText(line1, tx + fs * 0.4, ty - bh + fs * 0.85);
  if (line2) {
    ctx.font = `700 ${fs}px ${HUD_FONT}`;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(line2, tx + fs * 0.4, ty - fs * 0.4);
  }
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

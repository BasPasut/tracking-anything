import { applyHomography, BADMINTON_COURT, badmintonCourtCorners, computeHomography, type Point } from './homography';
import type { Track } from './types';

export interface SpeedOptions {
  /** Frames on each side used for the central difference. */
  span?: number;
  /** Speeds above this (km/h) are treated as detection jumps and ignored. World record smash is ~565. */
  maxKmh?: number;
  /** Window after the hit (seconds) in which the initial speed is measured. */
  initialWindowSec?: number;
}

/**
 * Map the track onto the court using 4 tapped corners and measure shuttle speed.
 *
 * `corners` are normalized image points (0..1) in the order far-left, far-right,
 * near-right, near-left of the doubles court.
 *
 * courtX/courtY are the floor projection of each point (exact only when the shuttle is
 * near the floor). Speed does not use them, because projecting an airborne shuttle onto
 * the floor blows up near the far baseline. Instead the image motion is converted with a
 * metres-per-pixel scale taken from the court width at that image row, interpolated
 * between the far and near baselines and clamped to them. That treats the motion as
 * happening in a plane facing the camera at that depth: an estimate, good to roughly
 * the near/far size ratio of the court in the picture.
 */
export function applyCourtCalibration(track: Track, corners: Point[], opts: SpeedOptions = {}): Track {
  const span = opts.span ?? 2;
  const maxKmh = opts.maxKmh ?? 500;
  const initWin = Math.max(1, Math.round((opts.initialWindowSec ?? 0.2) * track.fps));
  const H = computeHomography(corners, badmintonCourtCorners());

  const points = track.points.map((p) => {
    if (!p.visible) return { ...p, courtX: undefined, courtY: undefined, speedKmh: undefined };
    const c = applyHomography(H, p);
    return { ...p, courtX: c.x, courtY: c.y };
  });

  const W = track.width, Hpx = track.height;
  const [fl, fr, nr, nl] = corners.map((c) => ({ x: c.x * W, y: c.y * Hpx }));
  const farY = (fl.y + fr.y) / 2, nearY = (nl.y + nr.y) / 2;
  const farW = Math.hypot(fr.x - fl.x, fr.y - fl.y), nearW = Math.hypot(nr.x - nl.x, nr.y - nl.y);
  const metresPerPx = (yPx: number) => {
    const s = nearY === farY ? 1 : Math.max(0, Math.min(1, (yPx - farY) / (nearY - farY)));
    return BADMINTON_COURT.width / (farW + (nearW - farW) * s);
  };

  const raw: (number | undefined)[] = points.map((p, i) => {
    const a = points[i - span], b = points[i + span];
    if (!p.visible || !a?.visible || !b?.visible) return undefined;
    for (let k = i - span + 1; k <= i + span; k++) if (points[k]?.breakBefore) return undefined;
    const dt = b.t - a.t;
    if (dt <= 0) return undefined;
    const dpx = Math.hypot((b.x - a.x) * W, (b.y - a.y) * Hpx);
    const kmh = (dpx * metresPerPx(p.y * Hpx) / dt) * 3.6;
    return kmh <= maxKmh ? kmh : undefined;
  });
  // Median of 3 removes single-frame spikes from detection jitter.
  const speeds = raw.map((v, i) => {
    if (v === undefined) return undefined;
    const w = [raw[i - 1], v, raw[i + 1]].filter((x): x is number => x !== undefined).sort((x, y) => x - y);
    return w[Math.floor(w.length / 2)];
  });
  points.forEach((p, i) => { p.speedKmh = speeds[i]; });

  const rallies = track.rallies.map((r) => ({
    ...r,
    shots: r.shots.map((s) => {
      let peak: number | undefined, initial: number | undefined;
      for (let i = s.startIdx; i <= s.endIdx; i++) {
        const v = speeds[i];
        if (v === undefined) continue;
        if (peak === undefined || v > peak) peak = v;
        if (i - s.startIdx <= initWin && (initial === undefined || v > initial)) initial = v;
      }
      return { ...s, peakSpeedKmh: peak, initialSpeedKmh: initial ?? peak };
    }),
  }));

  return { ...track, points, rallies, calibration: { court: 'badminton-doubles', corners } };
}

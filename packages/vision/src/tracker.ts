import type { Detection, TrackPoint } from './types';

export interface TrackerOptions {
  /** Max distance (normalized units) between prediction and detection to accept it. */
  gate?: number;
  /** Frames without a detection before the track is dropped and re-acquired. */
  maxMissed?: number;
  /** Minimum confidence needed to start a new track. */
  minStartConfidence?: number;
  /** Process noise (how much velocity may change per frame). */
  processNoise?: number;
  /** Measurement noise of the detector. */
  measurementNoise?: number;
  /** Frames a challenger must match before it can take over the lock. */
  switchAfter?: number;
  /** Speed (normalized units per frame) above which a hypothesis looks like a shuttle in flight. */
  minFlightSpeed?: number;
}

/** 1-D constant-velocity Kalman filter. Two run in parallel for x and y. */
class Kalman1D {
  pos = 0; vel = 0;
  // Covariance [[p00, p01], [p01, p11]]
  p00 = 1; p01 = 0; p11 = 1;
  constructor(private q: number, private r: number) {}
  reset(pos: number) { this.pos = pos; this.vel = 0; this.p00 = this.r; this.p01 = 0; this.p11 = 1; }
  predict() {
    this.pos += this.vel;
    const p00 = this.p00 + 2 * this.p01 + this.p11 + this.q * 0.25;
    const p01 = this.p01 + this.p11 + this.q * 0.5;
    const p11 = this.p11 + this.q;
    this.p00 = p00; this.p01 = p01; this.p11 = p11;
  }
  update(z: number) {
    const s = this.p00 + this.r;
    const k0 = this.p00 / s, k1 = this.p01 / s;
    const y = z - this.pos;
    this.pos += k0 * y; this.vel += k1 * y;
    const p00 = (1 - k0) * this.p00;
    const p01 = (1 - k0) * this.p01;
    const p11 = this.p11 - k1 * this.p01;
    this.p00 = p00; this.p01 = p01; this.p11 = p11;
  }
}

/** One motion hypothesis: a pair of Kalman filters plus bookkeeping. */
class Hypothesis {
  kx: Kalman1D;
  ky: Kalman1D;
  hits = 0;
  missed = 0;
  /** Exponential moving average of speed, normalized units per frame. */
  speed = 0;
  constructor(q: number, r: number, from: Detection, to: Detection) {
    this.kx = new Kalman1D(q, r);
    this.ky = new Kalman1D(q, r);
    this.kx.reset(to.x); this.ky.reset(to.y);
    this.kx.vel = to.x - from.x; this.ky.vel = to.y - from.y;
    this.speed = Math.hypot(this.kx.vel, this.ky.vel);
    this.hits = 2;
  }
  predict() { this.kx.predict(); this.ky.predict(); }
  /** Best candidate inside the gate, or undefined. */
  match(cands: Detection[], gate: number): Detection | undefined {
    let best = Infinity, chosen: Detection | undefined;
    const g = gate * (1 + this.missed * 0.5);
    for (const c of cands) {
      const d = Math.hypot(c.x - this.kx.pos, c.y - this.ky.pos);
      const score = d - c.confidence * 0.01;
      if (d <= g && score < best) { best = score; chosen = c; }
    }
    return chosen;
  }
  update(c: Detection) {
    this.kx.update(c.x); this.ky.update(c.y);
    this.speed = 0.7 * this.speed + 0.3 * Math.hypot(this.kx.vel, this.ky.vel);
    this.hits++; this.missed = 0;
  }
}

/** Start a hypothesis from a candidate confirmed by a nearby candidate in the previous frame. */
function confirmStart(prev: Detection[], cands: Detection[], gate: number, minConf: number): [Detection, Detection] | undefined {
  let best = -Infinity, pair: [Detection, Detection] | undefined;
  for (const c of cands) {
    if (c.confidence < minConf) continue;
    for (const p of prev) {
      const d = Math.hypot(c.x - p.x, c.y - p.y);
      if (d > gate) continue;
      // Prefer confident pairs that actually move: a flying shuttle moves every frame.
      const score = c.confidence + p.confidence + Math.min(d, 0.05) * 10;
      if (score > best) { best = score; pair = [p, c]; }
    }
  }
  return pair;
}

/**
 * Online single-object tracker. Feed it the candidate detections of each frame in
 * order; it picks the candidate that fits the predicted motion and rejects the rest.
 *
 * A second "challenger" hypothesis follows the strongest unexplained candidate. If the
 * challenger keeps matching and moves clearly faster than the current lock (which may
 * be stuck on a slow false positive such as a player edge), the tracker switches to it.
 */
export class ShuttleTracker {
  private o: Required<TrackerOptions>;
  private main: Hypothesis | null = null;
  private challenger: Hypothesis | null = null;
  private prevFree: Detection[] = [];
  readonly points: TrackPoint[] = [];

  constructor(opts: TrackerOptions = {}) {
    this.o = {
      gate: opts.gate ?? 0.12,
      maxMissed: opts.maxMissed ?? 8,
      minStartConfidence: opts.minStartConfidence ?? 0.3,
      processNoise: opts.processNoise ?? 1e-4,
      measurementNoise: opts.measurementNoise ?? 1e-5,
      switchAfter: opts.switchAfter ?? 4,
      minFlightSpeed: opts.minFlightSpeed ?? 0.004,
    };
  }

  push(frame: number, t: number, candidates: Detection[]): TrackPoint {
    const { gate, maxMissed, minStartConfidence: minConf, processNoise: q, measurementNoise: r } = this.o;
    let chosen: Detection | undefined;

    if (this.main) {
      this.main.predict();
      chosen = this.main.match(candidates, gate);
      if (chosen) this.main.update(chosen);
      else if (++this.main.missed > maxMissed) this.main = null;
    }
    if (!this.main) {
      const pair = confirmStart(this.prevFree, candidates, gate, minConf);
      if (pair) { this.main = new Hypothesis(q, r, pair[0], pair[1]); chosen = pair[1]; this.challenger = null; }
    }

    // Challenger follows candidates the main hypothesis did not take.
    const free = candidates.filter((c) => c !== chosen);
    if (this.challenger) {
      this.challenger.predict();
      const c = this.challenger.match(free, gate);
      if (c) this.challenger.update(c);
      else if (++this.challenger.missed > 1) this.challenger = null;
      if (this.challenger && c && this.main && this.challenger.hits >= this.o.switchAfter &&
          this.challenger.speed > this.o.minFlightSpeed && this.challenger.speed > 2 * this.main.speed) {
        this.main = this.challenger;
        this.challenger = null;
        chosen = c;
      }
    } else if (this.main) {
      const pair = confirmStart(this.prevFree, free, gate, minConf);
      if (pair) this.challenger = new Hypothesis(q, r, pair[0], pair[1]);
    }
    this.prevFree = free;

    const point: TrackPoint = chosen && this.main
      ? { frame, t, x: this.main.kx.pos, y: this.main.ky.pos, visible: true, confidence: chosen.confidence, interpolated: false }
      : { frame, t, x: NaN, y: NaN, visible: false, confidence: 0, interpolated: false };
    this.points.push(point);
    return point;
  }
}

/**
 * Fill gaps of up to `maxGap` missing frames between two visible points with linear
 * interpolation (e.g. the shuttle hidden behind a player for a few frames).
 */
export function interpolateGaps(points: TrackPoint[], maxGap = 6): TrackPoint[] {
  const out = points.map((p) => ({ ...p }));
  let last = -1;
  for (let i = 0; i < out.length; i++) {
    if (!out[i].visible) continue;
    const gap = i - last - 1;
    if (last >= 0 && gap > 0 && gap <= maxGap) {
      const a = out[last], b = out[i];
      for (let j = last + 1; j < i; j++) {
        const f = (j - last) / (i - last);
        out[j] = { ...out[j], x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, visible: true, interpolated: true, confidence: 0 };
      }
    }
    last = i;
  }
  return out;
}

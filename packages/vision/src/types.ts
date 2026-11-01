/** A candidate shuttle position in one frame, in normalized image coordinates (0..1). */
export interface Detection {
  x: number;
  y: number;
  /** 0..1, how sure the detector is. */
  confidence: number;
}

/** One frame of a track. Coordinates are normalized (0..1) so they are independent of processing resolution. */
export interface TrackPoint {
  frame: number;
  /** Presentation time in seconds. */
  t: number;
  x: number;
  y: number;
  visible: boolean;
  confidence: number;
  /** True when the point was filled in across a short gap rather than detected. */
  interpolated: boolean;
  /** Court coordinates in metres, present once a calibration is applied. */
  courtX?: number;
  courtY?: number;
  /** Shuttle speed over the court in km/h, present once a calibration is applied. */
  speedKmh?: number;
}

export interface Shot {
  index: number;
  startFrame: number;
  endFrame: number;
  /** Index into track points where the shot starts (the hit) and ends. */
  startIdx: number;
  endIdx: number;
  /** Highest point on screen (smallest y) within the shot. */
  apexIdx: number;
  /** Fastest speed in the shot and speed just after the hit, km/h. Need a court calibration. */
  peakSpeedKmh?: number;
  initialSpeedKmh?: number;
}

export interface Rally {
  index: number;
  startFrame: number;
  endFrame: number;
  shots: Shot[];
}

export interface Track {
  schemaVersion: 1;
  sport: string;
  fps: number;
  width: number;
  height: number;
  detector: string;
  points: TrackPoint[];
  rallies: Rally[];
  /** Court corners the user tapped, normalized image coordinates. */
  calibration?: { court: string; corners: { x: number; y: number }[] };
}

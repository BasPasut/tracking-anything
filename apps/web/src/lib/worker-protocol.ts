import type { OverlayStyle, Track } from "@app/vision";

/** "tracknet": ML model, needs a still camera. "motion": simple frame differencing, the old fallback. */
export type DetectorKind = "tracknet" | "motion";

export type WorkerRequest =
  | { type: "analyze"; file: File; detector: DetectorKind }
  | { type: "export"; file: File; track: Track; style: OverlayStyle };

export type WorkerResponse =
  | { type: "progress"; stage: "load" | "background" | "analyze" | "export"; value: number }
  | { type: "analyzed"; track: Track }
  | { type: "exported"; buffer: ArrayBuffer; mimeType: string }
  | { type: "error"; message: string };

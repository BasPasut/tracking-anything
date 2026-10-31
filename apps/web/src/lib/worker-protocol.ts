import type { OverlayStyle, Track } from "@app/vision";

export type WorkerRequest =
  | { type: "analyze"; file: File }
  | { type: "export"; file: File; track: Track; style: OverlayStyle };

export type WorkerResponse =
  | { type: "progress"; stage: "analyze" | "export"; value: number }
  | { type: "analyzed"; track: Track }
  | { type: "exported"; buffer: ArrayBuffer; mimeType: string }
  | { type: "error"; message: string };

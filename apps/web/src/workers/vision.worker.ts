/// <reference lib="webworker" />
import {
  ALL_FORMATS, BlobSource, BufferTarget, CanvasSink, Conversion, Input, Mp4OutputFormat, Output,
} from "mediabunny";
import {
  medianBackground, MotionDetector, renderOverlay, runPipeline, TrackNetDetector,
  TRACKNET_HEIGHT, TRACKNET_WIDTH, type FrameInput,
} from "@app/vision";
import * as ort from "onnxruntime-web/webgpu";
import type { DetectorKind, WorkerRequest, WorkerResponse } from "@/lib/worker-protocol";

const post = (m: WorkerResponse, transfer: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(m, transfer);

/** Width frames are scaled to before detection. Coordinates are normalized, so this only trades speed for accuracy. */
const ANALYZE_WIDTH = 640;

/** fp16 halves the download; it needs a GPU with f16 shaders. Everything else uses fp32. */
const MODEL_FP16 = "/models/tracknetv3-fp16.onnx";
const MODEL_FP32 = "/models/tracknetv3-fp32.onnx";
/** Frames sampled across the clip to estimate the empty-court background. */
const BACKGROUND_SAMPLES = 32;

type Stage = "load" | "background" | "analyze";

/**
 * One progress bar for the whole analysis: each stage gets a slice of 0..1 sized to
 * how long it usually takes, so the bar only ever moves forward.
 */
function makeProgress(weights: Partial<Record<Stage, number>>) {
  const order: Stage[] = ["load", "background", "analyze"];
  const total = order.reduce((n, k) => n + (weights[k] ?? 0), 0) || 1;
  let last = 0;
  return (stage: Stage, value: number) => {
    let before = 0;
    for (const k of order) { if (k === stage) break; before += weights[k] ?? 0; }
    const overall = Math.min(1, (before + (weights[stage] ?? 0) * Math.max(0, Math.min(1, value))) / total);
    if (overall < last) return;
    last = overall;
    post({ type: "progress", stage, value: overall });
  };
}
type Progress = ReturnType<typeof makeProgress>;

let session: Promise<{ sess: ort.InferenceSession; backend: string }> | null = null;

async function fetchWithProgress(url: string, progress: Progress): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`โหลด model ไม่สำเร็จ (${res.status})`);
  const total = Number(res.headers.get("content-length")) || 0;
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    if (total) progress("load", got / total);
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

function getSession(progress: Progress, safe: boolean) {
  session ??= (async () => {
    // Served from public/ort (copied there by scripts/copy-ort.mjs).
    ort.env.wasm.wasmPaths = `${self.location.origin}/ort/`;
    // Multithreaded WASM needs cross-origin isolation (COOP/COEP headers in next.config).
    // Safe mode (a retry after a stall) and phones use fewer threads: shared memory for
    // many threads is what mobile browsers are most likely to refuse.
    type Gpu = { requestAdapter(): Promise<{ features: Set<string> } | null> };
    const gpu = (navigator as Navigator & { gpu?: Gpu }).gpu;
    const adapter = safe || !gpu ? null : await gpu.requestAdapter().catch(() => null);
    const f16 = !!adapter?.features.has("shader-f16");
    // With WebGPU the CPU threads only add risk: the threaded runtime and the GPU backend
    // together stalled the first inference. Threads are for the CPU path alone.
    const maxThreads = safe || adapter ? 1 : isMobile ? 4 : 8;
    const threads = self.crossOriginIsolated ? Math.max(1, Math.min(maxThreads, navigator.hardwareConcurrency || 4)) : 1;
    ort.env.wasm.numThreads = threads;
    // fp32 only for a GPU without f16. On CPU fp16 runs as fast and needs half the memory.
    const model = await fetchWithProgress(adapter && !f16 ? MODEL_FP32 : MODEL_FP16, progress);
    const cpu = `CPU ${threads} threads`;
    if (adapter) {
      try {
        return { sess: await ort.InferenceSession.create(model, { executionProviders: ["webgpu"] }), backend: "GPU" };
      } catch {
        // The GPU could not run the model: fall back to WASM.
      }
    }
    return { sess: await ort.InferenceSession.create(model, { executionProviders: ["wasm"] }), backend: cpu };
  })().catch((err) => { session = null; throw err; });
  return session;
}

async function makeTrackNet(video: Awaited<ReturnType<Input["getPrimaryVideoTrack"]>> & object, duration: number, progress: Progress, safe: boolean) {
  const { sess, backend } = await getSession(progress, safe);
  post({ type: "info", backend });
  // Background: median of frames spread evenly over the clip.
  const sink = new CanvasSink(video, { width: TRACKNET_WIDTH, height: TRACKNET_HEIGHT, fit: "fill" });
  const start = await video.getFirstTimestamp();
  const times = Array.from({ length: BACKGROUND_SAMPLES }, (_, i) => start + ((i + 0.5) / BACKGROUND_SAMPLES) * (duration - start));
  const frames: FrameInput[] = [];
  for await (const c of sink.canvasesAtTimestamps(times)) {
    if (!c) continue;
    const ctx = (c.canvas as OffscreenCanvas).getContext("2d", { willReadFrequently: true })!;
    frames.push({ data: ctx.getImageData(0, 0, TRACKNET_WIDTH, TRACKNET_HEIGHT).data, width: TRACKNET_WIDTH, height: TRACKNET_HEIGHT });
    progress("background", frames.length / BACKGROUND_SAMPLES);
  }
  const background = medianBackground(frames);
  const run = async (input: Float32Array) => {
    const feeds = { [sess.inputNames[0]]: new ort.Tensor("float32", input, [1, 27, TRACKNET_HEIGHT, TRACKNET_WIDTH]) };
    const out = await sess.run(feeds);
    const t = out[sess.outputNames[0]];
    const data = (await t.getData()) as Float32Array;
    t.dispose();
    return data;
  };
  return new TrackNetDetector(run, background);
}

async function analyze(file: File, kind: DetectorKind, safe: boolean) {
  const started = performance.now();
  // First sign of life, so the page knows the worker is running.
  post({ type: "progress", stage: "load", value: 0 });
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const video = await input.getPrimaryVideoTrack();
  if (!video) throw new Error("ไม่พบ video track ในไฟล์นี้");
  const duration = await input.computeDuration();
  const stats = await video.computePacketStats(100);
  const fps = stats.averagePacketRate || 30;
  const tracknet = kind === "tracknet";
  // Rough share of total time per stage; a model already loaded costs nothing.
  const progress = makeProgress({ load: tracknet && !session ? 0.12 : 0, background: tracknet ? 0.05 : 0, analyze: 1 });
  progress("load", 0);
  const detector = tracknet ? await makeTrackNet(video, duration, progress, safe) : new MotionDetector();
  if (!tracknet) post({ type: "info", backend: "CPU" });
  // TrackNet has a fixed input size; the motion detector keeps the aspect ratio.
  const w = tracknet ? TRACKNET_WIDTH : Math.min(ANALYZE_WIDTH, video.displayWidth);
  const h = tracknet ? TRACKNET_HEIGHT : Math.round((w / video.displayWidth) * video.displayHeight);
  const sink = new CanvasSink(video, { width: w, height: h, fit: "fill" });

  const source = {
    async *frames(): AsyncIterable<{ frame: FrameInput; t: number }> {
      for await (const c of sink.canvases()) {
        const ctx = (c.canvas as OffscreenCanvas).getContext("2d", { willReadFrequently: true })!;
        const img = ctx.getImageData(0, 0, w, h);
        yield { frame: { data: img.data, width: w, height: h }, t: c.timestamp };
      }
    },
  };

  const track = await runPipeline(source, {
    detector,
    fps,
    width: video.displayWidth,
    height: video.displayHeight,
    onProgress: (t) => progress("analyze", duration ? t / duration : 0),
  });
  post({ type: "analyzed", track, elapsedSec: (performance.now() - started) / 1000 });
}

async function exportVideo({ file, track, style }: Extract<WorkerRequest, { type: "export" }>) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat(), target });
  let canvas: OffscreenCanvas | null = null;

  const conversion = await Conversion.init({
    input,
    output,
    video: {
      codec: "avc",
      forceTranscode: true,
      process: (sample) => {
        const w = sample.displayWidth, h = sample.displayHeight;
        if (!canvas || canvas.width !== w || canvas.height !== h) canvas = new OffscreenCanvas(w, h);
        const ctx = canvas.getContext("2d")!;
        sample.draw(ctx, 0, 0, w, h);
        renderOverlay(ctx, track, sample.timestamp, w, h, style);
        return canvas;
      },
    },
  });
  if (!conversion.isValid) throw new Error("browser นี้ encode วิดีโอ MP4 ไม่ได้ ลองใช้ Chrome หรือ Edge รุ่นล่าสุด");
  conversion.onProgress = (p) => post({ type: "progress", stage: "export", value: p });
  await conversion.execute();
  const buffer = target.buffer!;
  post({ type: "exported", buffer, mimeType: "video/mp4" }, [buffer]);
}

// Errors outside the request handler (inside ONNX Runtime callbacks) still reach the page.
self.addEventListener("unhandledrejection", (e) => {
  post({ type: "error", message: e.reason instanceof Error ? e.reason.message : String(e.reason) });
});

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  try {
    if (e.data.type === "analyze") await analyze(e.data.file, e.data.detector, !!e.data.safe);
    else await exportVideo(e.data);
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};

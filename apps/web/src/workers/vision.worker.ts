/// <reference lib="webworker" />
import {
  ALL_FORMATS, BlobSource, BufferTarget, CanvasSink, Conversion, Input, Mp4OutputFormat, Output,
} from "mediabunny";
import {
  frameDifference, medianBackground, MotionDetector, renderOverlay, runPipeline, TrackNetDetector,
  TRACKNET_HEIGHT, TRACKNET_WIDTH, type FrameInput,
} from "@app/vision";
import * as ort from "onnxruntime-web/webgpu";
import type { DetectorKind, WorkerRequest, WorkerResponse } from "@/lib/worker-protocol";

const post = (m: WorkerResponse, transfer: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(m, transfer);

/** Width frames are scaled to before detection. Coordinates are normalized, so this only trades speed for accuracy. */
const ANALYZE_WIDTH = 640;

/** fp16 halves the download and is what the CPU runs; the GPU runs fp32, since half precision on some GPUs drifted far from the CPU's output. */
const MODEL_FP16 = "/models/tracknetv3-fp16.onnx";
const MODEL_FP32 = "/models/tracknetv3-fp32.onnx";
/** Frames sampled to estimate the empty-court background of a short clip. */
const BACKGROUND_SAMPLES = 32;
/** Longer clips get one background per stretch of this many seconds, from this many frames each. */
const BACKGROUND_WINDOW_SEC = 4;
const BACKGROUND_SAMPLES_PER_WINDOW = 12;
/** Sequences further than this from every background are skipped (camera moving). See TrackNetDetectorOptions. */
const MAX_BACKGROUND_DIFFERENCE = 16;

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

/** Set by the TrackNet setup for the clip being analyzed. */
let cameraMotion: number | undefined;

/**
 * GPU set-ups to try, in order. Some GPUs compute the model wrongly in one set-up and
 * correctly in another (the default NHWC layout, or the optimized graph, is where
 * driver bugs usually show), so each is checked against the CPU before it is used.
 */
const GPU_CONFIGS: { label: string; options: ort.InferenceSession.SessionOptions }[] = [
  { label: "GPU", options: { executionProviders: ["webgpu"] } },
  { label: "GPU NCHW", options: { executionProviders: [{ name: "webgpu", preferredLayout: "NCHW" }] } },
  { label: "GPU NCHW basic", options: { executionProviders: [{ name: "webgpu", preferredLayout: "NCHW" }], graphOptimizationLevel: "basic" } },
];

type Session = {
  sess: ort.InferenceSession;
  backend: string;
  /** GPU only: a CPU copy of the model to check against, and the model bytes for the next set-up. */
  check?: ort.InferenceSession;
  model?: Uint8Array;
  config?: number;
};
let session: Promise<Session> | null = null;

/** Thrown when no GPU set-up matches the CPU. */
class GpuMismatch extends Error {}
/** How many model runs the GPU is checked against the CPU on, at most. */
const GPU_CHECKS = 4;
/** Largest per-pixel heatmap difference (0..1) accepted between GPU and CPU. */
const GPU_TOLERANCE = 0.2;

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

function getSession(progress: Progress, safe: boolean, noGpu: boolean) {
  session ??= (async (): Promise<Session> => {
    // Served from public/ort (copied there by scripts/copy-ort.mjs).
    ort.env.wasm.wasmPaths = `${self.location.origin}/ort/`;
    // Multithreaded WASM needs cross-origin isolation (COOP/COEP headers in next.config).
    // Safe mode (a retry after a stall) and phones use fewer threads: shared memory for
    // many threads is what mobile browsers are most likely to refuse.
    type Gpu = { requestAdapter(): Promise<object | null> };
    const gpu = (navigator as Navigator & { gpu?: Gpu }).gpu;
    const adapter = safe || noGpu || !gpu ? null : await gpu.requestAdapter().catch(() => null);
    // With WebGPU the CPU threads only add risk: the threaded runtime and the GPU backend
    // together stalled the first inference. Threads are for the CPU path alone.
    const maxThreads = safe || adapter ? 1 : isMobile ? 4 : 8;
    const threads = self.crossOriginIsolated ? Math.max(1, Math.min(maxThreads, navigator.hardwareConcurrency || 4)) : 1;
    ort.env.wasm.numThreads = threads;
    const model = await fetchWithProgress(adapter ? MODEL_FP32 : MODEL_FP16, progress);
    const cpu = `CPU ${threads} threads`;
    if (adapter) {
      try {
        // A CPU copy of the same model to check the GPU's first results against.
        const check = await ort.InferenceSession.create(model, { executionProviders: ["wasm"] });
        for (let config = 0; config < GPU_CONFIGS.length; config++) {
          try {
            const sess = await ort.InferenceSession.create(model, GPU_CONFIGS[config].options);
            return { sess, check, model, config, backend: GPU_CONFIGS[config].label };
          } catch {
            // This set-up failed to build; try the next.
          }
        }
      } catch {
        // The GPU could not run the model: fall back to WASM.
      }
    }
    return { sess: await ort.InferenceSession.create(model, { executionProviders: ["wasm"] }), backend: cpu };
  })().catch((err) => { session = null; throw err; });
  return session;
}

async function runModel(sess: ort.InferenceSession, input: Float32Array) {
  const feeds = { [sess.inputNames[0]]: new ort.Tensor("float32", input, [1, 27, TRACKNET_HEIGHT, TRACKNET_WIDTH]) };
  const out = await sess.run(feeds);
  const t = out[sess.outputNames[0]];
  const data = (await t.getData()) as Float32Array;
  t.dispose();
  return data;
}

async function makeTrackNet(video: Awaited<ReturnType<Input["getPrimaryVideoTrack"]>> & object, duration: number, progress: Progress, safe: boolean, noGpu: boolean) {
  const s = await getSession(progress, safe, noGpu);
  post({ type: "info", backend: s.backend });
  // Backgrounds: one median per stretch of BACKGROUND_WINDOW_SEC, so a camera that moves
  // between still stretches gets a matching background for each.
  const sink = new CanvasSink(video, { width: TRACKNET_WIDTH, height: TRACKNET_HEIGHT, fit: "fill" });
  const start = await video.getFirstTimestamp();
  const span = Math.max(0.001, duration - start);
  const windows = Math.max(1, Math.round(span / BACKGROUND_WINDOW_SEC));
  const perWindow = windows === 1 ? BACKGROUND_SAMPLES : BACKGROUND_SAMPLES_PER_WINDOW;
  const total = windows * perWindow;
  const times = Array.from({ length: total }, (_, i) => start + ((i + 0.5) / total) * span);
  const backgrounds: FrameInput[] = [];
  const bgDiffs: number[] = [];
  let group: FrameInput[] = [];
  let seen = 0;
  const close = () => {
    if (!group.length) return;
    const bg = medianBackground(group);
    backgrounds.push(bg);
    for (const f of group) bgDiffs.push(frameDifference(f, bg));
    group = [];
  };
  for await (const c of sink.canvasesAtTimestamps(times)) {
    seen++;
    if (c) {
      const ctx = (c.canvas as OffscreenCanvas).getContext("2d", { willReadFrequently: true })!;
      group.push({ data: ctx.getImageData(0, 0, TRACKNET_WIDTH, TRACKNET_HEIGHT).data, width: TRACKNET_WIDTH, height: TRACKNET_HEIGHT });
    }
    if (seen % perWindow === 0) close();
    progress("background", seen / total);
  }
  close();
  if (!backgrounds.length) throw new Error("อ่านเฟรมจากวิดีโอไม่ได้");
  // How far frames sit from their own stretch's background: low for a tripod.
  bgDiffs.sort((a, b) => a - b);
  cameraMotion = bgDiffs[bgDiffs.length >> 1];
  // Some GPUs return heatmaps that miss the shuttle. Until the CPU copy has seen a
  // shuttle (or GPU_CHECKS runs passed), run both and compare; on a mismatch move on
  // to the next GPU set-up, and give up on the GPU when none is left.
  let checks = 0;
  const diffs: string[] = [];
  const run = async (input: Float32Array) => {
    let data = await runModel(s.sess, input);
    if (!s.check || checks >= GPU_CHECKS) return data;
    checks++;
    const ref = await runModel(s.check, input);
    for (;;) {
      let diff = 0, peak = 0;
      for (let i = 0; i < ref.length; i++) {
        const d = Math.abs(ref[i] - data[i]);
        if (!(d <= diff)) diff = d; // also catches NaN from the GPU
        if (ref[i] > peak) peak = ref[i];
      }
      if (diff <= GPU_TOLERANCE) {
        if (peak > 0.5) {
          // Verified on a real shuttle: later runs and clips trust this set-up.
          checks = GPU_CHECKS;
          s.check.release().catch(() => {});
          s.check = undefined;
        }
        return data;
      }
      diffs.push(`${GPU_CONFIGS[s.config!].label} ${diff.toFixed(2)}`);
      s.sess.release().catch(() => {});
      let next: ort.InferenceSession | null = null;
      while (!next && ++s.config! < GPU_CONFIGS.length) {
        next = await ort.InferenceSession.create(s.model!, GPU_CONFIGS[s.config!].options).catch(() => null);
      }
      if (!next) throw new GpuMismatch(diffs.join(", "));
      s.sess = next;
      s.backend = GPU_CONFIGS[s.config!].label;
      post({ type: "info", backend: s.backend });
      data = await runModel(s.sess, input);
    }
  };
  return new TrackNetDetector(run, backgrounds, { maxBackgroundDifference: MAX_BACKGROUND_DIFFERENCE, maxStillHits: 6 });
}

async function analyze(file: File, kind: DetectorKind, safe: boolean, noGpu: boolean) {
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
  cameraMotion = undefined;
  // Rough share of total time per stage; a model already loaded costs nothing.
  const progress = makeProgress({ load: tracknet && !session ? 0.12 : 0, background: tracknet ? 0.05 : 0, analyze: 1 });
  progress("load", 0);
  const detector = tracknet ? await makeTrackNet(video, duration, progress, safe, noGpu) : new MotionDetector();
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
  if (cameraMotion !== undefined) track.cameraMotion = cameraMotion;
  if (detector instanceof TrackNetDetector && detector.sequences) track.cameraMovingFraction = detector.skipped / detector.sequences;
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
    if (e.data.type === "analyze") await analyze(e.data.file, e.data.detector, !!e.data.safe, !!e.data.noGpu);
    else await exportVideo(e.data);
  } catch (err) {
    if (err instanceof GpuMismatch) return post({ type: "gpuMismatch", detail: err.message });
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};

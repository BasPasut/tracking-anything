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

const MODEL_URL = "/models/tracknetv3-fp16.onnx";
/** Frames sampled across the clip to estimate the empty-court background. */
const BACKGROUND_SAMPLES = 60;

let session: Promise<ort.InferenceSession> | null = null;

async function fetchWithProgress(url: string): Promise<Uint8Array> {
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
    if (total) post({ type: "progress", stage: "load", value: got / total });
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function getSession() {
  session ??= (async () => {
    // Served from public/ort (copied there by scripts/copy-ort.mjs).
    ort.env.wasm.wasmPaths = `${self.location.origin}/ort/`;
    const model = await fetchWithProgress(MODEL_URL);
    const hasGpu = "gpu" in navigator && !!(await (navigator as Navigator & { gpu: { requestAdapter(): Promise<unknown> } }).gpu.requestAdapter().catch(() => null));
    return ort.InferenceSession.create(model, { executionProviders: hasGpu ? ["webgpu", "wasm"] : ["wasm"] });
  })().catch((err) => { session = null; throw err; });
  return session;
}

async function makeTrackNet(video: Awaited<ReturnType<Input["getPrimaryVideoTrack"]>> & object, duration: number) {
  const sess = await getSession();
  // Background: median of frames spread evenly over the clip.
  const sink = new CanvasSink(video, { width: TRACKNET_WIDTH, height: TRACKNET_HEIGHT, fit: "fill" });
  const start = await video.getFirstTimestamp();
  const times = Array.from({ length: BACKGROUND_SAMPLES }, (_, i) => start + ((i + 0.5) / BACKGROUND_SAMPLES) * (duration - start));
  const frames: FrameInput[] = [];
  for await (const c of sink.canvasesAtTimestamps(times)) {
    if (!c) continue;
    const ctx = (c.canvas as OffscreenCanvas).getContext("2d", { willReadFrequently: true })!;
    frames.push({ data: ctx.getImageData(0, 0, TRACKNET_WIDTH, TRACKNET_HEIGHT).data, width: TRACKNET_WIDTH, height: TRACKNET_HEIGHT });
    post({ type: "progress", stage: "background", value: frames.length / BACKGROUND_SAMPLES });
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

async function analyze(file: File, kind: DetectorKind) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const video = await input.getPrimaryVideoTrack();
  if (!video) throw new Error("ไม่พบ video track ในไฟล์นี้");
  const duration = await input.computeDuration();
  const stats = await video.computePacketStats(100);
  const fps = stats.averagePacketRate || 30;
  const detector = kind === "tracknet" ? await makeTrackNet(video, duration) : new MotionDetector();
  // TrackNet has a fixed input size; the motion detector keeps the aspect ratio.
  const w = kind === "tracknet" ? TRACKNET_WIDTH : Math.min(ANALYZE_WIDTH, video.displayWidth);
  const h = kind === "tracknet" ? TRACKNET_HEIGHT : Math.round((w / video.displayWidth) * video.displayHeight);
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
    onProgress: (t) => post({ type: "progress", stage: "analyze", value: duration ? t / duration : 0 }),
  });
  post({ type: "analyzed", track });
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

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  try {
    if (e.data.type === "analyze") await analyze(e.data.file, e.data.detector);
    else await exportVideo(e.data);
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};

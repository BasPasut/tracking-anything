/// <reference lib="webworker" />
import {
  ALL_FORMATS, BlobSource, BufferTarget, CanvasSink, Conversion, Input, Mp4OutputFormat, Output,
} from "mediabunny";
import { MotionDetector, renderOverlay, runPipeline, type FrameInput } from "@app/vision";
import type { WorkerRequest, WorkerResponse } from "@/lib/worker-protocol";

const post = (m: WorkerResponse, transfer: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(m, transfer);

/** Width frames are scaled to before detection. Coordinates are normalized, so this only trades speed for accuracy. */
const ANALYZE_WIDTH = 640;

async function analyze(file: File) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const video = await input.getPrimaryVideoTrack();
  if (!video) throw new Error("ไม่พบ video track ในไฟล์นี้");
  const duration = await input.computeDuration();
  const stats = await video.computePacketStats(100);
  const fps = stats.averagePacketRate || 30;
  const w = Math.min(ANALYZE_WIDTH, video.displayWidth);
  const h = Math.round((w / video.displayWidth) * video.displayHeight);
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
    detector: new MotionDetector(),
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
    if (e.data.type === "analyze") await analyze(e.data.file);
    else await exportVideo(e.data);
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { defaultStyle, renderOverlay, trackToCsv, trackToJson, type OverlayStyle, type Track } from "@app/vision";
import type { WorkerRequest, WorkerResponse } from "@/lib/worker-protocol";

type Status =
  | { kind: "idle" }
  | { kind: "busy"; stage: "analyze" | "export"; value: number }
  | { kind: "ready" }
  | { kind: "error"; message: string };

function download(data: BlobPart, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function Studio() {
  const [file, setFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [track, setTrack] = useState<Track | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [style, setStyle] = useState<OverlayStyle>(defaultStyle);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const workerRef = useRef<Worker | null>(null);

  const getWorker = useCallback(() => {
    if (!workerRef.current) {
      const w = new Worker(new URL("../workers/vision.worker.ts", import.meta.url), { type: "module" });
      w.onmessage = (e: MessageEvent<WorkerResponse>) => {
        const m = e.data;
        if (m.type === "progress") setStatus({ kind: "busy", stage: m.stage, value: m.value });
        else if (m.type === "analyzed") { setTrack(m.track); setStatus({ kind: "ready" }); }
        else if (m.type === "exported") { download(m.buffer, "shuttle-tracked.mp4", m.mimeType); setStatus({ kind: "ready" }); }
        else setStatus({ kind: "error", message: m.message });
      };
      workerRef.current = w;
    }
    return workerRef.current;
  }, []);

  useEffect(() => () => workerRef.current?.terminate(), []);

  const send = (req: WorkerRequest) => getWorker().postMessage(req);

  const onFile = (f: File | undefined) => {
    if (!f) return;
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    setFile(f);
    setVideoUrl(URL.createObjectURL(f));
    setTrack(null);
    setStatus({ kind: "busy", stage: "analyze", value: 0 });
    send({ type: "analyze", file: f });
  };

  // Draw the overlay in sync with the video using the same renderer as the export.
  useEffect(() => {
    const video = videoRef.current, canvas = canvasRef.current;
    if (!video || !canvas || !track) return;
    let handle = 0;
    let stopped = false;
    const draw = (t: number) => {
      const w = video.videoWidth, h = video.videoHeight;
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      const ctx = canvas.getContext("2d")!;
      ctx.clearRect(0, 0, w, h);
      renderOverlay(ctx, track, t, w, h, style);
    };
    const loop: VideoFrameRequestCallback = (_now, meta) => {
      if (stopped) return;
      draw(meta.mediaTime);
      handle = video.requestVideoFrameCallback(loop);
    };
    handle = video.requestVideoFrameCallback(loop);
    const onSeek = () => draw(video.currentTime);
    video.addEventListener("seeked", onSeek);
    draw(video.currentTime);
    return () => {
      stopped = true;
      video.cancelVideoFrameCallback(handle);
      video.removeEventListener("seeked", onSeek);
    };
  }, [track, style]);

  const stats = useMemo(() => {
    if (!track) return null;
    const visible = track.points.filter((p) => p.visible).length;
    const shots = track.rallies.reduce((n, r) => n + r.shots.length, 0);
    return { frames: track.points.length, visible, rallies: track.rallies.length, shots };
  }, [track]);

  const busy = status.kind === "busy";

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_280px]">
      <section className="flex flex-col gap-3">
        {!videoUrl ? (
          <label
            className="flex aspect-video cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-zinc-300 text-zinc-500 hover:border-zinc-500 dark:border-zinc-700"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); onFile(e.dataTransfer.files[0]); }}
          >
            <span className="text-lg font-medium">ลากไฟล์วิดีโอมาวาง หรือคลิกเพื่อเลือก</span>
            <span className="text-sm">MP4 / MOV / WebM · กล้องตั้งนิ่ง 60 fps ขึ้นไปจะแม่นที่สุด</span>
            <input type="file" accept="video/*" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
          </label>
        ) : (
          <div className="relative overflow-hidden rounded-xl bg-black">
            <video ref={videoRef} src={videoUrl} controls playsInline className="block w-full" />
            <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />
          </div>
        )}
        {status.kind === "busy" && (
          <div className="flex items-center gap-3 text-sm">
            <span>{status.stage === "analyze" ? "กำลังจับลูก" : "กำลัง export วิดีโอ"} {Math.round(status.value * 100)}%</span>
            <div className="h-2 flex-1 rounded bg-zinc-200 dark:bg-zinc-800">
              <div className="h-2 rounded bg-sky-500" style={{ width: `${status.value * 100}%` }} />
            </div>
          </div>
        )}
        {status.kind === "error" && <p className="text-sm text-red-600">เกิดข้อผิดพลาด: {status.message}</p>}
      </section>

      <aside className="flex flex-col gap-5 text-sm">
        {stats && (
          <div className="grid grid-cols-2 gap-2">
            <Stat label="Rally" value={stats.rallies} />
            <Stat label="ช็อต" value={stats.shots} />
            <Stat label="เฟรมที่เห็นลูก" value={`${Math.round((stats.visible / stats.frames) * 100)}%`} />
            <Stat label="fps" value={track!.fps.toFixed(0)} />
          </div>
        )}

        <fieldset className="flex flex-col gap-2" disabled={!track}>
          <legend className="mb-1 font-medium">รูปแบบเส้น</legend>
          <label className="flex items-center justify-between gap-2">
            หางลูก (เฟรม)
            <input type="range" min={0} max={60} value={style.trailFrames} onChange={(e) => setStyle({ ...style, trailFrames: +e.target.value })} />
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={style.showShotPath} onChange={(e) => setStyle({ ...style, showShotPath: e.target.checked })} />
            เส้นวิถีทั้งช็อต
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={style.showMarkers} onChange={(e) => setStyle({ ...style, showMarkers: e.target.checked })} />
            จุดตี / จุดสูงสุด / จุดตก
          </label>
        </fieldset>

        <div className="flex flex-col gap-2">
          <span className="font-medium">Export</span>
          <button className="btn" disabled={!track || busy} onClick={() => file && track && send({ type: "export", file, track, style })}>
            วิดีโอ MP4 พร้อมเส้น
          </button>
          <button className="btn" disabled={!track} onClick={() => track && download(trackToCsv(track), "shuttle-track.csv", "text/csv")}>
            ข้อมูล CSV
          </button>
          <button className="btn" disabled={!track} onClick={() => track && download(trackToJson(track), "shuttle-track.json", "application/json")}>
            ข้อมูล JSON
          </button>
        </div>

        {videoUrl && (
          <button className="text-left text-zinc-500 underline" disabled={busy} onClick={() => { setVideoUrl(null); setFile(null); setTrack(null); setStatus({ kind: "idle" }); }}>
            เปลี่ยนวิดีโอ
          </button>
        )}
        <p className="text-xs text-zinc-500">
          ตอนนี้ใช้ตัวจับการเคลื่อนไหวแบบง่ายเป็นตัวชั่วคราว จะเปลี่ยนเป็น model TrackNet หลังผ่านเฟส 0
        </p>
      </aside>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-zinc-200 p-2 dark:border-zinc-800">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
    </div>
  );
}

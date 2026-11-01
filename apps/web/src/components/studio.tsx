"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyCourtCalibration, defaultStyle, renderCourt, renderOverlay, trackToCsv, trackToJson,
  type OverlayStyle, type Point, type Track,
} from "@app/vision";
import type { DetectorKind, WorkerRequest, WorkerResponse } from "@/lib/worker-protocol";
import { CameraCapture } from "@/components/camera-capture";

type Status =
  | { kind: "idle" }
  | { kind: "busy"; stage: "load" | "background" | "analyze" | "export"; value: number }
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
  const [cameraOpen, setCameraOpen] = useState(false);
  const [detector, setDetector] = useState<DetectorKind>("tracknet");
  const [backend, setBackend] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);
  /** Court corners tapped on the video (normalized). Four of them turn on speed. */
  const [corners, setCorners] = useState<Point[]>([]);
  const [calibrating, setCalibrating] = useState(false);
  const etaRef = useRef<{ stage: string; t0: number; v0: number } | null>(null);
  const [eta, setEta] = useState<number | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const workerRef = useRef<Worker | null>(null);

  const getWorker = useCallback(() => {
    if (!workerRef.current) {
      const w = new Worker(new URL("../workers/vision.worker.ts", import.meta.url), { type: "module" });
      w.onmessage = (e: MessageEvent<WorkerResponse>) => {
        const m = e.data;
        if (m.type === "progress") {
          setStatus({ kind: "busy", stage: m.stage, value: m.value });
          // Estimate time left from the rate of the current stage: the model download
          // and the analysis run at very different speeds, so each stage restarts the clock.
          const now = performance.now(), e = etaRef.current;
          if (!e || e.stage !== m.stage) { etaRef.current = { stage: m.stage, t0: now, v0: m.value }; setEta(null); }
          else if ((m.stage === "analyze" || m.stage === "export") && m.value - e.v0 > 0.02 && now - e.t0 > 1500) setEta(((now - e.t0) / (m.value - e.v0)) * (1 - m.value) / 1000);
        }
        else if (m.type === "info") setBackend(m.backend);
        else if (m.type === "analyzed") {
          etaRef.current = null; setEta(null); setTrack(m.track); setElapsed(m.elapsedSec); setStatus({ kind: "ready" }); }
        else if (m.type === "exported") { etaRef.current = null; setEta(null); download(m.buffer, "shuttle-tracked.mp4", m.mimeType); setStatus({ kind: "ready" }); }
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
    setCameraOpen(false);
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    setFile(f);
    setVideoUrl(URL.createObjectURL(f));
    setCorners([]);
    setCalibrating(false);
    setElapsed(null);
    setTrack(null);
    setStatus({ kind: "busy", stage: "analyze", value: 0 });
    send({ type: "analyze", file: f, detector });
  };

  const reanalyze = (kind: DetectorKind) => {
    setDetector(kind);
    if (!file) return;
    setTrack(null);
    setElapsed(null);
    setStatus({ kind: "busy", stage: "analyze", value: 0 });
    send({ type: "analyze", file, detector: kind });
  };

  // The court calibration is cheap to apply, so it runs on the client whenever corners change.
  const shown = useMemo(() => {
    if (!track || corners.length !== 4) return track;
    try { return applyCourtCalibration(track, corners); } catch { return track; }
  }, [track, corners]);

  const onVideoClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!calibrating) return;
    const r = e.currentTarget.getBoundingClientRect();
    const p = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
    const next = [...corners, p].slice(0, 4);
    setCorners(next);
    if (next.length === 4) setCalibrating(false);
  };

  // Draw the overlay in sync with the video using the same renderer as the export.
  useEffect(() => {
    const video = videoRef.current, canvas = canvasRef.current;
    if (!video || !canvas || (!shown && !calibrating)) return;
    let handle = 0;
    let stopped = false;
    const draw = (t: number) => {
      const w = video.videoWidth, h = video.videoHeight;
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      const ctx = canvas.getContext("2d")!;
      ctx.clearRect(0, 0, w, h);
      if (calibrating) { renderCourt(ctx, corners, w, h); return; }
      if (shown) renderOverlay(ctx, shown, t, w, h, style);
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
  }, [shown, style, calibrating, corners]);

  const stats = useMemo(() => {
    if (!track) return null;
    const visible = track.points.filter((p) => p.visible).length;
    const shots = track.rallies.reduce((n, r) => n + r.shots.length, 0);
    return { frames: track.points.length, visible, rallies: track.rallies.length, shots };
  }, [track]);

  const shotList = useMemo(() => shown?.rallies.flatMap((r) => r.shots.map((s) => ({ rally: r.index, ...s, t: shown.points[s.startIdx].t }))) ?? [], [shown]);
  const topSpeed = shotList.reduce<number | undefined>((m, s) => (s.initialSpeedKmh !== undefined && (m === undefined || s.initialSpeedKmh > m) ? s.initialSpeedKmh : m), undefined);

  const busy = status.kind === "busy";

  return (
    <div className="studio grid gap-6">
      <section className="studio-media flex min-w-0 flex-col gap-3">
        {!videoUrl && cameraOpen ? (
          <CameraCapture onRecorded={onFile} onCancel={() => setCameraOpen(false)} />
        ) : !videoUrl ? (
          <div className="flex flex-col gap-3">
            <label
              className="media-frame flex aspect-video cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-zinc-300 text-zinc-500 hover:border-zinc-500 dark:border-zinc-700"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); onFile(e.dataTransfer.files[0]); }}
            >
              <span className="text-lg font-medium">ลากไฟล์วิดีโอมาวาง หรือคลิกเพื่อเลือก</span>
              <span className="text-sm">MP4 / MOV / WebM · กล้องตั้งนิ่ง 60 fps ขึ้นไปจะแม่นที่สุด</span>
              <input type="file" accept="video/*" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
            </label>
            <button className="btn self-start" onClick={() => setCameraOpen(true)}>ถ่ายจากกล้องแทน</button>
          </div>
        ) : (
          // Shrink-wrap the video so the overlay canvas covers exactly the picture, with no letterbox.
          <div className="relative mx-auto w-fit max-w-full overflow-hidden rounded-xl bg-black">
            <video ref={videoRef} src={videoUrl} controls playsInline className="media-frame block h-auto w-auto max-w-full" />
            <canvas ref={canvasRef} onClick={onVideoClick}
              className={`absolute inset-0 h-full w-full ${calibrating ? "cursor-crosshair" : "pointer-events-none"}`} />
            {calibrating && (
              <div className="pointer-events-none absolute inset-x-0 top-0 bg-black/70 px-3 py-2 text-center text-sm text-white">
                แตะมุมคอร์ทเส้นนอก (คู่) ตามลำดับ: {["ซ้ายฝั่งไกล", "ขวาฝั่งไกล", "ขวาฝั่งใกล้", "ซ้ายฝั่งใกล้"][corners.length]} ({corners.length + 1}/4)
              </div>
            )}
          </div>
        )}
        {status.kind === "busy" && (
          <div className="flex items-center gap-3 text-sm">
            <span>{STAGE_LABEL[status.stage]} {Math.round(status.value * 100)}%{eta !== null ? ` · เหลืออีกประมาณ ${formatDuration(eta)}` : ""}</span>
            <div className="h-2 flex-1 rounded bg-zinc-200 dark:bg-zinc-800">
              <div className="h-2 rounded bg-sky-500" style={{ width: `${status.value * 100}%` }} />
            </div>
          </div>
        )}
        {status.kind === "error" && <p className="text-sm text-red-600">เกิดข้อผิดพลาด: {status.message}</p>}
      </section>

      <aside className="studio-panel flex flex-col gap-3 text-sm md:gap-5">
        {videoUrl && (
          <div className="flex items-center justify-between">
            <span className="font-medium">ผลการวิเคราะห์</span>
            <button className="text-zinc-500 underline" disabled={busy}
              onClick={() => { setVideoUrl(null); setFile(null); setTrack(null); setStatus({ kind: "idle" }); }}>
              เปลี่ยนวิดีโอ
            </button>
          </div>
        )}

        <label className="flex items-center justify-between gap-3">
          <span className="font-medium">ตัวจับลูก</span>
          <select className="min-h-11 rounded-lg border border-zinc-300 bg-transparent px-2 dark:border-zinc-700" value={detector} disabled={busy}
            onChange={(e) => reanalyze(e.target.value as DetectorKind)}>
            <option value="tracknet">TrackNetV3 (กล้องขาตั้ง)</option>
            <option value="motion">Motion แบบง่าย</option>
          </select>
        </label>

        {stats && (
          <div className="grid grid-cols-4 gap-1.5 md:grid-cols-2 md:gap-2">
            <Stat label="Rally" value={stats.rallies} />
            <Stat label="ช็อต" value={stats.shots} />
            <Stat label="เห็นลูก" value={`${Math.round((stats.visible / stats.frames) * 100)}%`} />
            <Stat label="เร็วสุด km/h" value={topSpeed !== undefined ? Math.round(topSpeed) : "–"} />
          </div>
        )}

        {track && (
          <div className="flex flex-col gap-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">ความเร็วลูก</span>
              <button className="text-sky-600 underline" disabled={busy}
                onClick={() => { setCorners([]); setCalibrating(true); videoRef.current?.pause(); }}>
                {corners.length === 4 ? "ปักมุมคอร์ทใหม่" : "ปักมุมคอร์ท"}
              </button>
            </div>
            {corners.length !== 4 ? (
              <p className="text-xs text-zinc-500">ปักหมุด 4 มุมของคอร์ทบนวิดีโอ เพื่อให้รู้ระยะจริงและคำนวณความเร็วเป็น km/h</p>
            ) : shotList.length === 0 ? (
              <p className="text-xs text-zinc-500">ยังไม่พบช็อตในคลิปนี้</p>
            ) : (
              <ol className="max-h-40 overflow-y-auto text-xs md:max-h-56">
                {shotList.map((s) => (
                  <li key={`${s.rally}-${s.index}`}>
                    <button className="flex w-full justify-between gap-2 rounded px-1 py-1 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800"
                      onClick={() => { const v = videoRef.current; if (v) v.currentTime = s.t; }}>
                      <span>Rally {s.rally + 1} · ช็อต {s.index + 1}</span>
                      <span className="font-semibold tabular-nums">{s.initialSpeedKmh !== undefined ? `${Math.round(s.initialSpeedKmh)} km/h` : "–"}</span>
                    </button>
                  </li>
                ))}
              </ol>
            )}
            {corners.length === 4 && <p className="text-[11px] text-zinc-500">ความเร็วตามแนวพื้นคอร์ท ลูกโด่งจะอ่านได้ต่ำกว่าจริง</p>}
          </div>
        )}

        {elapsed !== null && track && (
          <p className="text-xs text-zinc-500">
            ใช้เวลา {formatDuration(elapsed)} ({(track.points.length / elapsed).toFixed(1)} เฟรม/วินาที){backend ? ` · ${backend}` : ""}
          </p>
        )}

        {videoUrl && (<>
        <div className="grid grid-cols-3 gap-1.5 md:grid-cols-1 md:gap-2">
          <button className="btn text-center md:text-left" disabled={!track || busy} onClick={() => file && track && send({ type: "export", file, track: shown ?? track, style })}>
            <span className="md:hidden">MP4</span><span className="hidden md:inline">Export วิดีโอ MP4 พร้อมเส้น</span>
          </button>
          <button className="btn btn-quiet text-center md:text-left" disabled={!track} onClick={() => track && download(trackToCsv(shown ?? track), "shuttle-track.csv", "text/csv")}>
            CSV<span className="hidden md:inline">&nbsp;ข้อมูลรายเฟรม</span>
          </button>
          <button className="btn btn-quiet text-center md:text-left" disabled={!track} onClick={() => track && download(trackToJson(shown ?? track), "shuttle-track.json", "application/json")}>
            JSON
          </button>
        </div>

        <details className="group rounded-lg border border-zinc-200 dark:border-zinc-800">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between px-3 font-medium">
            รูปแบบเส้น
            <span className="text-zinc-500 transition group-open:rotate-180">▾</span>
          </summary>
          <fieldset className="flex flex-col gap-3 px-3 pb-3" disabled={!track}>
            <label className="flex items-center justify-between gap-3">
              หางลูก {style.trailFrames} เฟรม
              <input type="range" min={0} max={60} value={style.trailFrames} className="w-32" onChange={(e) => setStyle({ ...style, trailFrames: +e.target.value })} />
            </label>
            <label className="flex min-h-8 items-center gap-2">
              <input type="checkbox" className="h-5 w-5" checked={style.showShotPath} onChange={(e) => setStyle({ ...style, showShotPath: e.target.checked })} />
              เส้นวิถีทั้งช็อต
            </label>
            <label className="flex min-h-8 items-center gap-2">
              <input type="checkbox" className="h-5 w-5" checked={style.showMarkers} onChange={(e) => setStyle({ ...style, showMarkers: e.target.checked })} />
              จุดตี / จุดสูงสุด / จุดตก
            </label>
            <label className="flex min-h-8 items-center gap-2">
              <input type="checkbox" className="h-5 w-5" checked={style.showSpeed} onChange={(e) => setStyle({ ...style, showSpeed: e.target.checked })} />
              ป้ายความเร็วบนวิดีโอ
            </label>
          </fieldset>
        </details>
        </>)}

        <p className="hidden text-xs text-zinc-500 md:block">
          TrackNetV3 ต้องใช้กล้องตั้งนิ่ง ถ่ายแนวนอนเห็นคอร์ท ครั้งแรกจะโหลด model ประมาณ 23 MB
        </p>
      </aside>
    </div>
  );
}

function formatDuration(sec: number) {
  if (sec < 60) return `${Math.max(1, Math.round(sec))} วินาที`;
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return s ? `${m} นาที ${s} วินาที` : `${m} นาที`;
}

const STAGE_LABEL = {
  load: "กำลังโหลด model",
  background: "กำลังหาพื้นหลังคอร์ท",
  analyze: "กำลังจับลูก",
  export: "กำลัง export วิดีโอ",
} as const;

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-zinc-200 px-2 py-1.5 dark:border-zinc-800 md:p-2">
      <div className="truncate text-[11px] text-zinc-500 md:text-xs">{label}</div>
      <div className="text-base font-semibold md:text-lg">{value}</div>
    </div>
  );
}

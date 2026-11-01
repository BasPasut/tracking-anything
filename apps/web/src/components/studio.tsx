"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  applyCourtCalibration, defaultStyle, renderCourt, renderOverlay, trackToCsv, trackToJson,
  type OverlayStyle, type Point, type Track,
} from "@app/vision";
import type { DetectorKind, WorkerRequest, WorkerResponse } from "@/lib/worker-protocol";
import { CameraCapture } from "@/components/camera-capture";

/** Set once this browser's GPU has failed the check against the CPU; later runs skip the GPU. */
// Versioned: a new set of GPU set-ups to try clears the old verdict.
const NO_GPU_KEY = "shuttle-tracker.no-gpu.v2";
function gpuDistrusted() {
  try { return !!localStorage.getItem(NO_GPU_KEY); } catch { return false; }
}

type Status =
  | { kind: "idle" }
  | { kind: "busy"; stage: "load" | "background" | "analyze" | "export"; value: number }
  | { kind: "ready" }
  | { kind: "error"; message: string; reload?: boolean };

/** Wall clock for the stall watchdog (kept outside the component: it is only read in handlers). */
const clock = () => performance.now();

/**
 * Download name: the source video's name, a suffix for what the file is, and the local
 * date and time, e.g. "rally_tracked_20261101-153012.mp4".
 */
function outputName(source: string | undefined, suffix: string, ext: string) {
  const base = (source ?? "").replace(/\.[^.]*$/, "").replace(/[\\/:*?"<>|]+/g, "_").trim() || "shuttle";
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${base}_${suffix}_${stamp}.${ext}`;
}

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
  /** The source name for the worker's handlers, which outlive the render they were made in. */
  const fileNameRef = useRef<string | undefined>(undefined);
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
  const fileRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const workerRef = useRef<Worker | null>(null);
  /** The request in flight and when the worker last said anything, for the stall watchdog. */
  const pendingRef = useRef<{ req: WorkerRequest; lastMsg: number; heard: boolean } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const lastStageRef = useRef("start");

  // Plain functions: they only touch refs and state setters, so the copies bound to the
  // worker's handlers stay valid across renders.
  function getWorker() {
    if (!workerRef.current) {
      const w = new Worker(new URL("../workers/vision.worker.ts", import.meta.url), { type: "module" });
      w.onerror = (e) => {
        e.preventDefault();
        // An error before the worker said anything usually means its script is gone:
        // this tab was loaded from an older deploy. Retrying can't help; a reload can.
        // The detail line is for bug reports: what failed, where, and how far it got.
        const where = e.filename ? ` @ ${e.filename.split("/").pop()}:${e.lineno}` : "";
        const detail = ` (รายละเอียด: ${e.message || "no message"}${where}; ขั้นตอนล่าสุด ${lastStageRef.current})`;
        if (!pendingRef.current?.heard) return fail(`โหลดตัวประมวลผลไม่ได้ อาจเป็นเพราะเว็บเพิ่งอัปเดต${detail}`, true);
        fail(`ตัวประมวลผลขัดข้อง${detail}`);
      };
      w.onmessageerror = () => fail("รับข้อมูลจากตัวประมวลผลไม่ได้");
      w.onmessage = (e: MessageEvent<WorkerResponse>) => {
        const m = e.data;
        const p = pendingRef.current;
        if (p) { p.lastMsg = performance.now(); p.heard = true; }
        if (m.type === "analyzed" || m.type === "exported" || m.type === "error") pendingRef.current = null;
        if (m.type === "progress") {
          lastStageRef.current = `${m.stage} ${Math.round(m.value * 100)}%`;
          setStatus({ kind: "busy", stage: m.stage, value: m.value });
          // Estimate time left from the rate of the current stage: the model download
          // and the analysis run at very different speeds, so each stage restarts the clock.
          const now = performance.now(), e = etaRef.current;
          if (!e || e.stage !== m.stage) { etaRef.current = { stage: m.stage, t0: now, v0: m.value }; setEta(null); }
          else if ((m.stage === "analyze" || m.stage === "export") && m.value - e.v0 > 0.02 && now - e.t0 > 1500) setEta(((now - e.t0) / (m.value - e.v0)) * (1 - m.value) / 1000);
        }
        else if (m.type === "gpuMismatch") {
          // This GPU gets the model wrong: remember that, and redo the clip on the CPU.
          try { localStorage.setItem(NO_GPU_KEY, m.detail); } catch {}
          w.terminate();
          workerRef.current = null;
          if (p?.req.type === "analyze") {
            setNotice(`GPU ของเครื่องนี้ให้ผลไม่ตรงกับ CPU เลยเปลี่ยนไปประมวลผลด้วย CPU แทน (ช้ากว่าแต่แม่นกว่า) [${m.detail}]`);
            send({ ...p.req, noGpu: true });
          }
        }
        else if (m.type === "info") setBackend(m.backend);
        else if (m.type === "analyzed") {
          etaRef.current = null; setEta(null); setTrack(m.track); setElapsed(m.elapsedSec); setStatus({ kind: "ready" }); }
        else if (m.type === "exported") { etaRef.current = null; setEta(null); download(m.buffer, outputName(fileNameRef.current, "tracked", "mp4"), m.mimeType); setStatus({ kind: "ready" }); }
        else setStatus({ kind: "error", message: m.message });
      };
      workerRef.current = w;
    }
    return workerRef.current;
  }

  useEffect(() => () => workerRef.current?.terminate(), []);

  function send(req: WorkerRequest) {
    lastStageRef.current = "start";
    pendingRef.current = { req, lastMsg: clock(), heard: false };
    getWorker().postMessage(req);
  }

  // A worker that crashed or hung (a phone browser killing it for memory, say) sends
  // nothing. Restart it once in safe mode (one CPU thread, small model), then give up
  // with an error instead of a progress bar that never moves.
  function fail(reason: string, stale = false) {
    const p = pendingRef.current;
    pendingRef.current = null;
    workerRef.current?.terminate();
    workerRef.current = null;
    etaRef.current = null;
    setEta(null);
    if (stale) {
      setStatus({ kind: "error", message: `${reason} กรุณารีเฟรชหน้าแล้วลองใหม่`, reload: true });
      return;
    }
    if (p && p.req.type === "analyze" && p.req.detector === "tracknet" && !p.req.safe) {
      setNotice("ประมวลผลแบบปกติไม่สำเร็จ กำลังลองใหม่แบบประหยัดหน่วยความจำ (ช้ากว่า)");
      setStatus({ kind: "busy", stage: "load", value: 0 });
      send({ ...p.req, safe: true });
      return;
    }
    setStatus({ kind: "error", message: `${reason} ลองใช้ Chrome หรือ Edge รุ่นล่าสุด หรือเลือกตัวจับลูกแบบ Motion` });
  }

  useEffect(() => {
    if (status.kind !== "busy") return;
    const id = setInterval(() => {
      const p = pendingRef.current;
      if (!p) return;
      const quiet = performance.now() - p.lastMsg;
      if (!p.heard && quiet > 20_000) fail("ตัวประมวลผลไม่ตอบสนอง");
      else if (quiet > 120_000) fail("ประมวลผลค้าง ไม่มีความคืบหน้าเกิน 2 นาที");
    }, 5000);
    return () => clearInterval(id);
    // `fail` only uses refs and setters, so the first copy is as good as any.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.kind]);

  const onFile = (f: File | undefined) => {
    if (!f) return;
    setCameraOpen(false);
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    setFile(f);
    fileNameRef.current = f.name;
    setVideoUrl(URL.createObjectURL(f));
    setCorners([]);
    setCalibrating(false);
    setElapsed(null);
    setNotice(null);
    setTrack(null);
    setStatus({ kind: "busy", stage: "analyze", value: 0 });
    send({ type: "analyze", file: f, detector, noGpu: gpuDistrusted() });
  };

  const reanalyze = (kind: DetectorKind) => {
    setDetector(kind);
    if (!file) return;
    setTrack(null);
    setElapsed(null);
    setStatus({ kind: "busy", stage: "analyze", value: 0 });
    send({ type: "analyze", file, detector: kind, noGpu: gpuDistrusted() });
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
            {/* One file input for both the drop zone and the button, so phones (no drag and drop) get a clear button. */}
            <input ref={fileRef} type="file" accept="video/*" className="hidden" onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ""; }} />
            <div
              role="button"
              tabIndex={0}
              className="media-frame flex aspect-video cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-zinc-300 px-4 text-center text-zinc-500 hover:border-zinc-500 dark:border-zinc-700"
              onClick={() => fileRef.current?.click()}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") fileRef.current?.click(); }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); onFile(e.dataTransfer.files[0]); }}
            >
              <span className="text-lg font-medium [@media(pointer:coarse)]:hidden">ลากไฟล์วิดีโอมาวาง หรือกดปุ่มด้านล่าง</span>
              <span className="hidden text-lg font-medium [@media(pointer:coarse)]:inline">แตะเพื่อเลือกวิดีโอจากเครื่อง</span>
              <span className="text-sm">MP4 / MOV / WebM · กล้องตั้งนิ่ง 60 fps ขึ้นไปจะแม่นที่สุด</span>
            </div>
            <div className="flex flex-wrap gap-2">
              <button className="btn" onClick={() => fileRef.current?.click()}>อัปโหลดวิดีโอ</button>
              <button className="btn btn-quiet" onClick={() => setCameraOpen(true)}>ถ่ายจากกล้อง</button>
            </div>
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
        {notice && status.kind === "busy" && <p className="text-sm text-amber-600">{notice}</p>}
        {status.kind === "error" && (
          <div className="flex flex-wrap items-center gap-2 text-sm text-red-600">
            <p>เกิดข้อผิดพลาด: {status.message}</p>
            {status.reload && (
              <button type="button" className="btn" onClick={() => location.reload()}>รีเฟรชหน้า</button>
            )}
          </div>
        )}
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

        {track?.cameraMotion !== undefined && track.cameraMotion > CAMERA_MOTION_WARN && (
          <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">
            กล้องขยับระหว่างคลิปนี้ TrackNetV3 ต้องใช้กล้องตั้งนิ่ง (ขาตั้ง) ผลจับลูกจึงคลาดเคลื่อน การรองรับคลิปถือถ่ายอยู่ในเฟสถัดไป
          </p>
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
          <button className="btn btn-quiet text-center md:text-left" disabled={!track} onClick={() => track && download(trackToCsv(shown ?? track), outputName(file?.name, "track", "csv"), "text/csv")}>
            CSV<span className="hidden md:inline">&nbsp;ข้อมูลรายเฟรม</span>
          </button>
          <button className="btn btn-quiet text-center md:text-left" disabled={!track} onClick={() => track && download(trackToJson(shown ?? track), outputName(file?.name, "track", "json"), "application/json")}>
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
              แสดงความเร็ว (km/h)
            </label>
            <label className="flex min-h-8 items-center gap-2">
              <input type="checkbox" className="h-5 w-5" checked={style.showHud} onChange={(e) => setStyle({ ...style, showHud: e.target.checked })} />
              แถบสถิติด้านบน (เวลา rally / ช็อต / ความเร็ว)
            </label>
            <label className="flex min-h-8 items-center gap-2">
              <input type="checkbox" className="h-5 w-5" checked={style.showLockOn} onChange={(e) => setStyle({ ...style, showLockOn: e.target.checked })} />
              เป้าล็อกลูก
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

/** Above this cameraMotion score the clip is treated as handheld. Tripod clips measured 1-5, handheld 28-36. */
const CAMERA_MOTION_WARN = 18;

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

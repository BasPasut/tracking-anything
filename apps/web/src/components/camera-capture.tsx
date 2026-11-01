"use client";

import { useEffect, useRef, useState } from "react";

/** Container/codec choices in order of preference. MP4 first so Safari and new Chrome skip a remux. */
const MIME_CANDIDATES = [
  "video/mp4;codecs=avc1",
  "video/mp4",
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
];

function pickMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
}

type Facing = "environment" | "user";

interface Props {
  /** Called with the finished recording, ready for the same pipeline as an uploaded file. */
  onRecorded: (file: File) => void;
  onCancel: () => void;
}

/**
 * Records a clip from the device camera in the browser. The clip is handed back as a
 * File, so tracking, drawing and export work exactly as for an uploaded video.
 * Camera access needs HTTPS (Vercel gives this) or localhost.
 */
export function CameraCapture({ onRecorded, onCancel }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const [facing, setFacing] = useState<Facing>("environment");
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<MediaTrackSettings | null>(null);
  const [recording, setRecording] = useState(false);
  const [startedAt, setStartedAt] = useState(0);
  const [elapsed, setElapsed] = useState(0);

  // Open (or reopen, when switching cameras) the camera stream.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError("browser นี้เปิดกล้องไม่ได้ หรือเว็บไม่ได้เปิดผ่าน HTTPS");
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: facing },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
            // Higher frame rate makes a fast shuttle much easier to track.
            frameRate: { ideal: 60 },
          },
        });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        setSettings(stream.getVideoTracks()[0]?.getSettings() ?? null);
        setError(null);
        if (videoRef.current) videoRef.current.srcObject = stream;
      } catch (err) {
        const name = err instanceof DOMException ? err.name : "";
        setError(
          name === "NotAllowedError" ? "ไม่ได้รับอนุญาตให้ใช้กล้อง กรุณาอนุญาตในการตั้งค่า browser"
          : name === "NotFoundError" ? "ไม่พบกล้องในอุปกรณ์นี้"
          : `เปิดกล้องไม่ได้: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    })();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [facing]);

  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => setElapsed((performance.now() - startedAt) / 1000), 250);
    return () => clearInterval(id);
  }, [recording, startedAt]);

  const start = () => {
    const stream = streamRef.current;
    if (!stream) return;
    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(stream, {
      ...(mimeType ? { mimeType } : {}),
      videoBitsPerSecond: 12_000_000,
    });
    chunksRef.current = [];
    recorder.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data); };
    recorder.onstop = () => {
      const type = recorder.mimeType || mimeType || "video/webm";
      const ext = type.includes("mp4") ? "mp4" : "webm";
      const blob = new Blob(chunksRef.current, { type });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      onRecorded(new File([blob], `camera-${stamp}.${ext}`, { type }));
    };
    recorder.start(1000);
    recorderRef.current = recorder;
    setStartedAt(performance.now());
    setElapsed(0);
    setRecording(true);
  };

  const stop = () => {
    recorderRef.current?.stop();
    recorderRef.current = null;
    setRecording(false);
  };

  const fps = settings?.frameRate ? Math.round(settings.frameRate) : null;

  return (
    <div className="flex flex-col gap-3">
      <div className="relative overflow-hidden rounded-xl bg-black">
        <video ref={videoRef} autoPlay muted playsInline className="block aspect-video w-full object-contain" />
        {recording && (
          <div className="absolute left-3 top-3 flex items-center gap-2 rounded-full bg-black/60 px-3 py-1 text-sm text-white">
            <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-red-500" />
            {Math.floor(elapsed / 60)}:{String(Math.floor(elapsed % 60)).padStart(2, "0")}
          </div>
        )}
        {settings && (
          <div className="absolute right-3 top-3 rounded-full bg-black/60 px-3 py-1 text-xs text-white">
            {settings.width}×{settings.height}{fps ? ` · ${fps} fps` : ""}
          </div>
        )}
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {fps !== null && fps < 50 && !error && (
        <p className="text-sm text-amber-600">
          กล้องนี้ให้ได้ {fps} fps ลูกที่ตบแรงอาจเบลอจนจับไม่ได้ ถ้าเป็นไปได้ใช้กล้องที่ถ่าย 60 fps
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 text-sm">
        {!recording ? (
          <button className="btn !bg-red-600 !text-white" disabled={!!error || !settings} onClick={start}>
            ● เริ่มอัด
          </button>
        ) : (
          <button className="btn" onClick={stop}>■ หยุดและวิเคราะห์</button>
        )}
        <button className="btn !bg-transparent !text-current ring-1 ring-zinc-300 dark:ring-zinc-700" disabled={recording}
          onClick={() => setFacing(facing === "environment" ? "user" : "environment")}>
          สลับกล้อง
        </button>
        <button className="text-zinc-500 underline" disabled={recording} onClick={onCancel}>ยกเลิก</button>
      </div>
      <p className="text-xs text-zinc-500">ตั้งกล้องบนขาตั้งให้นิ่ง เห็นคอร์ททั้งสนาม แล้วกดเริ่มอัด</p>
    </div>
  );
}

# tracking-anything

Webapp ที่จับการเคลื่อนที่ของลูกแบดจากวิดีโอ วาดเส้นวิถี ดึงข้อมูล และ export เป็นวิดีโอ MP4 หรือ CSV/JSON
ทุกขั้นตอนประมวลผลใน browser ของผู้ใช้ (Web Worker + WebCodecs) ไม่ต้องมี GPU server

Design doc: https://claude.ai/artifact/Jct7aMw2YsDkNc6esmEbw9

## สถานะ

เฟส 0 (spike) กำลังทำ สิ่งที่ใช้ได้แล้ว:

- อัปโหลดวิดีโอ (MP4 / MOV / WebM) แล้ว decode ทีละเฟรมด้วย [Mediabunny](https://mediabunny.dev)
- จับลูกด้วย `MotionDetector` (three-frame differencing) ซึ่งเป็นตัวชั่วคราว จะเปลี่ยนเป็น TrackNet (ONNX + WebGPU)
- Tracker แบบ Kalman ที่กรองจุดหลอกและสลับไปหาลูกที่กำลังบินได้ เติมช่วงที่ลูกหายสั้นๆ
- แบ่ง rally และช็อตจากจุดที่ทิศทางลูกเปลี่ยน หาจุดตี จุดสูงสุด จุดตก
- วาดเส้นแบบหางลูก เส้นทั้งช็อต และ marker ด้วยฟังก์ชันเดียวกันทั้ง preview และ export
- Export MP4 (H.264 + เสียงเดิม), CSV ต่อเฟรม, JSON
- Homography สำหรับแปลงพิกัดภาพเป็นพิกัดคอร์ท (ยังไม่มี UI)

ยังไม่มี: กล้องสด, calibrate คอร์ท, database, login, อัปโหลดขึ้น cloud (ดู roadmap ใน design doc)

## โครงสร้าง

```
apps/web          Next.js 16 (App Router) — UI + Web Worker ที่รัน pipeline และ export
packages/vision   CV core ที่ไม่ผูกกับ framework: detector, tracker, segment, homography, render, export
scripts/          ตัวสร้างวิดีโอทดสอบ และ smoke test ด้วย Playwright
```

`packages/vision` ใช้ `SportProfile` ในอนาคตเพื่อรองรับกีฬาอื่น (ความเร็วลูก, วิถีลูกบาส) โดยไม่ต้องแก้ UI

## เริ่มใช้งาน

```bash
pnpm install
pnpm dev          # http://localhost:3000
pnpm test         # unit tests ของ packages/vision
pnpm typecheck && pnpm lint && pnpm build
```

ทดสอบแบบ end-to-end ด้วยวิดีโอสังเคราะห์:

```bash
python3 scripts/make-synthetic-rally.py | ffmpeg -f rawvideo -pix_fmt rgb24 -s 1280x720 -r 60 -i - -c:v libx264 -pix_fmt yuv420p rally.mp4
pnpm build && node apps/web/.next/standalone/apps/web/server.js &   # copy .next/static into the standalone folder first
BASE_URL=http://localhost:3000/ node scripts/e2e-smoke.cjs rally.mp4
```

## Deploy

**Vercel (internal ช่วงแรก)**: import repo โดยปล่อย Root Directory เป็น root ของ repo
`vercel.json` ใช้ Vercel Services และประกาศ service เดียวคือ `web` (Next.js ใน `apps/web`) ที่รับทุก path
เมื่อมี backend เพิ่ม (เช่น GPU worker ในเฟส 3) ให้เพิ่มเป็น service ใหม่ใน `services` แบบ internal
แล้วให้ `web` เรียกผ่าน binding แทนการ hardcode URL ทดสอบทุก service พร้อมกันในเครื่องด้วย `vercel dev`
แนะนำเปิด Deployment Protection หรือ Vercel Authentication ไว้จนกว่าจะมี login ของแอปเอง

**Container (AWS หรือที่อื่น)**: `docker build -t tracking-anything-web .` แล้วรันบน ECS Fargate / App Runner
CI build Docker image ทุกครั้งเพื่อยืนยันว่ายังย้ายออกจาก Vercel ได้

## Browser ที่รองรับ

ต้องมี WebCodecs: Chrome / Edge รุ่นใหม่ และ Safari 26 ขึ้นไป Firefox ยัง export H.264 ไม่ได้ในบางระบบ

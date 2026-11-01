// Copies the ONNX Runtime Web files the worker loads into public/ort, so the app
// serves them itself (no CDN), on Vercel and in the AWS container alike.
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const dist = dirname(require.resolve("onnxruntime-web/webgpu"));
const out = join(import.meta.dirname, "..", "public", "ort");
mkdirSync(out, { recursive: true });
for (const f of ["ort-wasm-simd-threaded.asyncify.mjs", "ort-wasm-simd-threaded.asyncify.wasm"]) {
  copyFileSync(join(dist, f), join(out, f));
}
console.log("copied onnxruntime-web files to public/ort");

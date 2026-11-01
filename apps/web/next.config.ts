import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server build so the same app runs on Vercel or in a Docker container on AWS.
  output: "standalone",
  transpilePackages: ["@app/vision"],
  cacheComponents: true,
  // Cross-origin isolation enables SharedArrayBuffer, so the model can use every CPU core.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
        ],
      },
      {
        source: "/:dir(models|ort)/:file*",
        headers: [{ key: "Cache-Control", value: "public, max-age=86400" }],
      },
    ];
  },
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;

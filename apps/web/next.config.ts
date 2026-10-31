import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server build so the same app runs on Vercel or in a Docker container on AWS.
  output: "standalone",
  transpilePackages: ["@app/vision"],
  cacheComponents: true,
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

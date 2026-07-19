import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone server bundle for the Docker image (reproducible-builds spec
  // 2026-07-18); local `next start` dev flow is unaffected.
  output: "standalone",
};

export default nextConfig;

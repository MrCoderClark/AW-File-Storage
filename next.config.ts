import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // App-specific Next config goes here as the build grows.
};

export default nextConfig;

// Enables the Cloudflare bindings (D1, R2, env) in `next dev`, so local
// development runs against the same binding shapes as production.
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
initOpenNextCloudflareForDev();

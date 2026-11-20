import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep dynamic React Router paths available in `next dev`; export a static
  // SPA bundle for Firebase Hosting only during production builds.
  output: process.env.NODE_ENV === "production" ? "export" : undefined,
  distDir: "./dist",
  // Preserve the existing local emulator switch while exposing only this
  // non-secret toggle to client code.
  env: {
    NEXT_PUBLIC_USE_FIREBASE_EMULATORS:
      process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATORS ?? process.env.VITE_USE_FIREBASE_EMULATORS ?? "false",
  },
  experimental: {
    agentFeedback: true,
  },
};

export default nextConfig;

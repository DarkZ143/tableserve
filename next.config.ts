import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Development keeps client-side routes available; production exports a
  // static SPA whose hosts rewrite routes such as /t/{restaurantId}/{qrToken}.
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

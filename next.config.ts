import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  eslint: {
    // Disable ESLint errors from failing the production build
    ignoreDuringBuilds: true,
  },
  typescript: {
    // Allow production builds to succeed even if there are type errors
    ignoreBuildErrors: true,
  },
};

export default nextConfig;

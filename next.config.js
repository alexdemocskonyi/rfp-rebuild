/** @type {import("next").NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // ✅ Enable Node.js runtime for API routes
  output: "standalone",
  experimental: {
    appDir: true, // ensures the new App Router is active
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
};

module.exports = nextConfig;

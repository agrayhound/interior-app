/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Prevent webpack from bundling native Node addons used by @xenova/transformers.
    // onnxruntime-node ships a prebuilt .node binary that must be loaded at runtime.
    serverComponentsExternalPackages: ["@xenova/transformers", "onnxruntime-node"],
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "**" },
      { protocol: "http", hostname: "**" },
    ],
  },
};

export default nextConfig;

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Prevent webpack from bundling native Node addons used by @xenova/transformers.
    // onnxruntime-node ships a prebuilt .node binary that must be loaded at runtime.
    // sharp is a native addon — must not be bundled by webpack (same as onnxruntime-node)
    serverComponentsExternalPackages: ["@xenova/transformers", "onnxruntime-node", "sharp"],
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "**" },
      { protocol: "http", hostname: "**" },
    ],
  },
};

export default nextConfig;

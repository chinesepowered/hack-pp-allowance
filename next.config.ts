import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The PayPal SDKs are plain Node libraries: keep them out of the bundle so
  // the agent toolkit and our logging interceptor share one axios instance.
  serverExternalPackages: ["@paypal/agent-toolkit", "@paypal/paypal-server-sdk", "axios"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  images: { unoptimized: true },
  // The Channel3 stand-in responses are read from disk at run time.
  outputFileTracingIncludes: { "/api/**/*": ["./fixtures/channel3/**/*"] },
  devIndicators: false,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // The PayPal approval popup needs to talk back to this window.
          { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
        ],
      },
    ];
  },
};

export default nextConfig;

import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";

// React's development build needs eval() for debugging features (call stack reconstruction);
// production builds never use it, so 'unsafe-eval' is only allowed under `next dev`.
const scriptSrc = process.env.NODE_ENV === "development" ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'" : "script-src 'self' 'unsafe-inline'";

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  {
    key: "Content-Security-Policy",
    value: `default-src 'self'; ${scriptSrc}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`,
  },
];

const config: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: fileURLToPath(new URL("../../", import.meta.url)),
  transpilePackages: ["@gtc/shared", "@gtc/db"],
  serverExternalPackages: ["postgres"],
  poweredByHeader: false,
  experimental: { serverActions: { bodySizeLimit: "256kb" } },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};
export default config;

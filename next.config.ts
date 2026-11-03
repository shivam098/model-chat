import type { NextConfig } from "next";

const config: NextConfig = {
  distDir: process.env.MODEL_CHAT_CANDIDATE_BUILD === "1" ? ".next-candidate" : ".next",
  poweredByHeader: false,
  serverExternalPackages: ["@github/copilot-sdk", "better-sqlite3"],
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Permissions-Policy", value: "camera=(), geolocation=(), microphone=(self)" },
        { key: "Content-Security-Policy", value: `default-src 'self'; script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'` }
      ],
    }, {
      // Verified code-runner previews (images, video, PDF only) get a stricter, script-free policy.
      source: "/api/chats/:chat/files/:file/preview",
      headers: [{ key: "Content-Security-Policy", value: "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'; sandbox" }],
    }];
  },
};
export default config;

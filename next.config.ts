import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pass pages carry guests' names, so keep them out of search by default.
  async headers() {
    return [{ source: "/p/:path*", headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }] }];
  },
};

export default nextConfig;

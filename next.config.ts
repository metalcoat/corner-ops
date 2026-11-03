import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Downloads (door alarm .zip, Android .apk, ...) are replaced in place under the same name: browsers and
  // Cloudflare must check for a newer one every time, or a "new" download can hand out the old build.
  async headers() {
    return [{ source: "/downloads/:path*", headers: [{ key: "Cache-Control", value: "no-cache, must-revalidate" }] }];
  },
};

export default nextConfig;

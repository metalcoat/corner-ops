import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Downloads (door alarm .zip, Android .apk, ...) are replaced in place under the same name: browsers and
  // Cloudflare must check for a newer one every time, or a "new" download can hand out the old build.
  async headers() {
    return [{ source: "/downloads/:path*", headers: [{ key: "Cache-Control", value: "no-cache, must-revalidate" }] }];
  },
  // People pages moved under /ops/people (2026-11); old bookmarks and texted links keep working.
  async redirects() {
    return [
      { source: "/ops/employees", destination: "/ops/people/team", permanent: false },
      { source: "/ops/employment-forms", destination: "/ops/people/paperwork", permanent: false },
      { source: "/ops/direct-deposit", destination: "/ops/people/paperwork/direct-deposit", permanent: false },
      { source: "/ops/employee-handbook", destination: "/ops/people/handbook", permanent: false },
    ];
  },
};

export default nextConfig;

import type { MetadataRoute } from "next";
import { connection } from "next/server";
import { customerSitemap } from "@/lib/customer-seo";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  // Built per request so PUBLIC_SITE_URL is read from the running server, not the build.
  await connection();
  return customerSitemap();
}

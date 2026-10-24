import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import { isCustomerHost } from "@/lib/customer-domain-routing";
import { CUSTOMER_SITE_URL } from "@/lib/customer-seo";

// Only the public ordering site is meant for search engines; every staff,
// dev and team host asks them to stay out.
export default async function robots(): Promise<MetadataRoute.Robots> {
  const host = ((await headers()).get("host") || "").split(":")[0];
  if (!isCustomerHost(host)) return { rules: { userAgent: "*", disallow: "/" } };
  return {
    rules: { userAgent: "*", allow: ["/order", "/menu", "/privacy", "/terms", "/refund-policy"], disallow: ["/account", "/track", "/order/confirmation", "/api/"] },
    sitemap: `${CUSTOMER_SITE_URL}/sitemap.xml`,
  };
}

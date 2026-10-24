import type { MetadataRoute } from "next";
import { CUSTOMER_SITE_URL } from "@/lib/customer-seo";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: `${CUSTOMER_SITE_URL}/order`, changeFrequency: "daily", priority: 1 },
    { url: `${CUSTOMER_SITE_URL}/refund-policy`, changeFrequency: "yearly", priority: 0.2 },
    { url: `${CUSTOMER_SITE_URL}/privacy`, changeFrequency: "yearly", priority: 0.2 },
    { url: `${CUSTOMER_SITE_URL}/terms`, changeFrequency: "yearly", priority: 0.2 },
  ];
}

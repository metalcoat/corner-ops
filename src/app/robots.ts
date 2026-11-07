import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import { customerRobots } from "@/lib/customer-seo";

// Only the production ordering site (ALLOW_INDEXING=true) is open to search
// engines; every staff, dev, LAN and team host asks them to stay out.
export default async function robots(): Promise<MetadataRoute.Robots> {
  return customerRobots((await headers()).get("host") || "");
}

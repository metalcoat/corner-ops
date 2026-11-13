import type { Metadata } from "next";
import { headers } from "next/headers";
import { customerPageMetadata, publicPage } from "@/lib/customer-seo";

/** Title, description, canonical, social tags and robots for one public page. */
export async function publicPageMetadata(path: string): Promise<Metadata> {
  return customerPageMetadata(publicPage(path), (await headers()).get("host") || "");
}

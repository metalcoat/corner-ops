import type { Metadata } from "next";
import CustomerOrder from "./customer-order";
import { CUSTOMER_SITE_URL, ORDER_PAGE_DESCRIPTION, ORDER_PAGE_TITLE, restaurantJsonLd } from "@/lib/customer-seo";
import "./order.css";

export const metadata: Metadata = {
  title: ORDER_PAGE_TITLE,
  description: ORDER_PAGE_DESCRIPTION,
  alternates: { canonical: `${CUSTOMER_SITE_URL}/order` },
  openGraph: { title: ORDER_PAGE_TITLE, description: ORDER_PAGE_DESCRIPTION, url: `${CUSTOMER_SITE_URL}/order`, siteName: "Corner Deli", type: "website", images: [`${CUSTOMER_SITE_URL}/corner-deli-logo.png`] },
};
export default function OrderPage() {
  return (
    <>
      {/* Static schema.org data (no user input), so search results can show hours, phone and the order link. */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(restaurantJsonLd()).replace(/</g, "\\u003c") }} />
      <CustomerOrder />
    </>
  );
}

import type { Metadata } from "next";

// Customer accounts are personal: never in search results.
export const metadata: Metadata = { title: "Your account | Corner Deli", robots: { index: false, follow: false } };

export default function AccountLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}

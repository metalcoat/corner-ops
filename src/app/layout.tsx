import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Corner Ops",
  description: "Internal operations for Corner Deli and Tiki",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

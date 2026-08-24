import type { Metadata, Viewport } from "next";
import GlobalNav from "./global-nav";
import PwaClient from "./pwa-client";
import "./globals.css";
import "./operations.css";
import "./business-theme.css";
import "./pwa.css";

const THEME_BOOTSTRAP = `try{var b=localStorage.getItem("corner-ops-business-theme");if(b==="Corner Deli"||b==="Tiki")document.documentElement.dataset.businessTheme=b}catch(e){}`;

export const metadata: Metadata = {
  title: "Corner Ops",
  description: "Internal operations for Corner Deli and Tiki",
  manifest: "/manifest.webmanifest",
  applicationName: "Corner Ops",
  appleWebApp: {
    capable: true,
    title: "Corner Ops",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: "/corner-ops-icon.svg",
    apple: "/corner-ops-icon.svg",
  },
};

export const viewport: Viewport = {
  themeColor: "#0f172a",
  viewportFit: "cover",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-business-theme="Corner Deli" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} /></head>
      <body>
        <GlobalNav />
        {children}
        <PwaClient />
      </body>
    </html>
  );
}

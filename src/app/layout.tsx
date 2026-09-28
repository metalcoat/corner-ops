import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { siteBrandForHost } from "@/lib/site-brand";
import { BrandProvider } from "./brand-context";
import GlobalNav from "./global-nav";
import PwaClient from "./pwa-client";
import "./color-tokens.css";
import "./globals.css";
import "./business-theme.css";
import "./pwa.css";

const THEME_BOOTSTRAP = `try{var b=localStorage.getItem("corner-ops-business-theme");if(b==="Corner Deli"||b==="Tiki")document.documentElement.dataset.businessTheme=b}catch(e){}`;

export async function generateMetadata(): Promise<Metadata> {
  const brand = siteBrandForHost((await headers()).get("host") || "");
  const appName = brand.teamHost ? brand.name : "Ops";
  return {
    title: appName,
    description: brand.teamHost ? `${brand.name} team workspace` : "Internal operations for Corner Deli and Tiki",
    manifest: "/manifest.webmanifest",
    applicationName: appName,
    appleWebApp: { capable: true, title: appName, statusBarStyle: "black-translucent" },
    icons: { icon: brand.icon, apple: brand.icon },
  };
}

export const viewport: Viewport = {
  themeColor: "#0f172a",
  viewportFit: "cover",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const brand = siteBrandForHost((await headers()).get("host") || "");
  return (
    <html lang="en" data-business-theme="Corner Deli" data-site-brand={brand.name} suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} /></head>
      <body>
        <BrandProvider value={brand}>
          <GlobalNav teamHost={brand.teamHost} brand={brand} />
          {children}
          <PwaClient />
        </BrandProvider>
      </body>
    </html>
  );
}

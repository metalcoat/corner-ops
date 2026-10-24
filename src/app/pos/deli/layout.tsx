import type { ReactNode } from "react";
import type { Metadata } from "next";
import { getPosSettings } from "@/lib/ordering-pos-settings";
import DeliPosShell from "./deli-pos-shell";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Corner Deli POS",
  manifest: "/pos/deli/manifest.webmanifest",
  applicationName: "Corner Deli POS",
  appleWebApp: { capable: true, title: "Corner Deli POS", statusBarStyle: "black-translucent" },
};

export default async function DeliLayout({ children }: { children: ReactNode }) {
  const settings = await getPosSettings("Corner Deli");
  return <DeliPosShell idleLockSeconds={settings.posIdleLockSeconds} alertSound={settings.onlineOrderAlertSound} alertVolume={settings.onlineOrderAlertVolume}>{children}</DeliPosShell>;
}

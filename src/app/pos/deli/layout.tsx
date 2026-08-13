import type { ReactNode } from "react";
import { getPosSettings } from "@/lib/ordering-pos-settings";
import DeliPosShell from "./deli-pos-shell";

export const dynamic = "force-dynamic";

export default async function DeliLayout({ children }: { children: ReactNode }) {
  const settings = await getPosSettings("Corner Deli");
  return <DeliPosShell idleLockSeconds={settings.posIdleLockSeconds}>{children}</DeliPosShell>;
}

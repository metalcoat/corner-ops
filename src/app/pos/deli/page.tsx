import PosClient from "../pos-client";
import "../pos-separation.css";
import { getPosSettings } from "@/lib/ordering-pos-settings";
export const dynamic = "force-dynamic";

export default async function DeliPosPage() {
  const settings = await getPosSettings("Corner Deli");
  return <PosClient business="Corner Deli" idleLockSeconds={settings.posIdleLockSeconds} />;
}

import KitchenClient from "./kitchen-client";
import "./kitchen.css";
import { getPosSettings } from "@/lib/ordering-pos-settings";
export const dynamic = "force-dynamic";

export default async function DeliKitchenPage() {
  const settings = await getPosSettings("Corner Deli");
  return <KitchenClient idleLockSeconds={settings.posIdleLockSeconds} />;
}

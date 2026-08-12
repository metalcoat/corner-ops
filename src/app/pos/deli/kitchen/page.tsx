import KitchenClient from "./kitchen-client";
import "./kitchen.css";

export default function DeliKitchenPage() {
  const seconds = Number.parseInt(process.env.POS_IDLE_LOCK_SECONDS || "60", 10);
  return <KitchenClient idleLockSeconds={Number.isFinite(seconds) ? seconds : 60} />;
}

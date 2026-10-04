import KitchenClient from "./kitchen-client";
import "./kitchen.css";
export const dynamic = "force-dynamic";

export default async function DeliKitchenPage() {
  // The kitchen display intentionally ignores the POS idle-lock setting.
  return <KitchenClient />;
}

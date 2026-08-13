import DeliverySettingsClient from "./delivery-settings-client";
import PosSettingsClient from "./pos-settings-client";
import StoreOperationsSettingsClient from "./store-operations-settings-client";
import PromotionsSettingsClient from "./promotions-settings-client";

export default function DeliDeliverySettingsPage() {
  return <><PosSettingsClient /><StoreOperationsSettingsClient /><DeliverySettingsClient /><PromotionsSettingsClient /></>;
}

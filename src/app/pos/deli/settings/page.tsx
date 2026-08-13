import DeliverySettingsClient from "./delivery-settings-client";
import PosSettingsClient from "./pos-settings-client";
import StoreOperationsSettingsClient from "./store-operations-settings-client";

export default function DeliDeliverySettingsPage() {
  return <><PosSettingsClient /><StoreOperationsSettingsClient /><DeliverySettingsClient /></>;
}

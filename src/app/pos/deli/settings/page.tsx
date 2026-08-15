import DeliverySettingsClient from "./delivery-settings-client";
import PosSettingsClient from "./pos-settings-client";
import StoreOperationsSettingsClient from "./store-operations-settings-client";
import PromotionsSettingsClient from "./promotions-settings-client";
import LoyaltySettingsClient from "./loyalty-settings-client";
import GiftCardSettingsClient from "./gift-card-settings-client";
import BarcodeSettingsClient from "./barcode-settings-client";

export default function DeliDeliverySettingsPage() {
  return <><PosSettingsClient /><StoreOperationsSettingsClient /><DeliverySettingsClient /><PromotionsSettingsClient /><LoyaltySettingsClient /><GiftCardSettingsClient /><BarcodeSettingsClient /></>;
}

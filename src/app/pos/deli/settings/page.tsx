import DeliverySettingsClient from "./delivery-settings-client";
import PosSettingsClient from "./pos-settings-client";
import StoreOperationsSettingsClient from "./store-operations-settings-client";
import GreeterTvSettingsClient from "./greeter-tv-settings-client";
import LobbyTriviaSettingsClient from "./lobby-trivia-settings-client";
import PromotionsSettingsClient from "./promotions-settings-client";
import LoyaltySettingsClient from "./loyalty-settings-client";
import GiftCardSettingsClient from "./gift-card-settings-client";
import BarcodeSettingsClient from "./barcode-settings-client";
import HardwareSettingsClient from "./hardware-settings-client";
import AiPhoneSettingsClient from "./ai-phone-settings-client";
import AiPhoneRulesClient from "./ai-phone-rules-client";

export default function DeliDeliverySettingsPage() {
  return <><AiPhoneSettingsClient /><AiPhoneRulesClient /><PosSettingsClient /><HardwareSettingsClient /><GreeterTvSettingsClient /><LobbyTriviaSettingsClient /><StoreOperationsSettingsClient /><DeliverySettingsClient /><PromotionsSettingsClient /><LoyaltySettingsClient /><GiftCardSettingsClient /><BarcodeSettingsClient /></>;
}

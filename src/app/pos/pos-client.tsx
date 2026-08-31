"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Business, SessionView } from "@/lib/types";
import PosPinGate, {
  type PosEmployeeSession,
  type PosSessionView,
} from "./pos-pin-gate";
import type { ServiceType } from "@/lib/ordering-core";
import type { OrderTimingMode } from "@/lib/ordering-timing-core";
import {
  orderingBusinessConfig,
  type PosUtility,
} from "@/lib/ordering-business-config";
import type {
  OrderingComboView,
  OrderingModifierGroupView,
  OrderingModifierOptionView,
} from "@/lib/ordering-menu";
import type {
  OrderingItemVariantView,
  OrderingMenuCategoryWithVariants,
  OrderingMenuItemWithVariants,
} from "@/lib/ordering-menu-variants";
import "./pos.css";
import { usePosIdleLock } from "./use-pos-idle-lock";
import PizzaToppingSelector from "@/components/pizza-topping-selector";
import {
  formatModifierIntensity,
  supportsSubModifierIntensity,
} from "@/lib/ordering-modifier-intensity";
import { unwrapHelcimPayResponse } from "@/lib/helcim-pay-response";
import ItemCancellationPanel from "./deli/orders/item-cancellation-panel";
import {
  formatPizzaTopping,
  normalizePizzaToppings,
  pizzaToppingPriceCents,
  type PizzaToppingSelection,
} from "@/lib/ordering-pizza-toppings";
import { itemNeedsConfiguration } from "@/lib/ordering-menu-presentation";
import Link from "next/link";
import { isHumanTextEntry, KeyboardWedgeDetector } from "@/lib/barcode-scanner";
import { giftCardNumberFromInput, validGiftCardInput } from "@/lib/gift-card-input";
import { consolidateQuantities } from "@/lib/cart-line-consolidation";

type PosServiceType = Exclude<ServiceType, "undecided">;

type CartLine = {
  id: string;
  itemId: string;
  variantId: string | null;
  variantName: string;
  name: string;
  quantity: number;
  unitPriceCents: number;
  modifierText: string[];
  comboText: string[];
  modifierSelections: Record<string, string[]>;
  modifierQuantities: Record<string, number>;
  modifierAmounts: Record<string, "light" | "normal" | "heavy">;
  modifierDeclines: string[];
  pizzaToppings: PizzaToppingSelection[];
  comboId: string | null;
  comboSelections: Record<string, string[]>;
  specialInstructions: string;
};

function cartLineConfiguration(line:CartLine){const {id:_id,quantity:_quantity,modifierText:_modifierText,comboText:_comboText,...configuration}=line;return configuration}
function appendOrIncrementCartLine(current:CartLine[],line:CartLine){return consolidateQuantities([...current,line],cartLineConfiguration)}

type MenuPayload = {
  business: Business;
  categories: OrderingMenuCategoryWithVariants[];
};

type SavedDraft = {
  id: string;
  displayNumber: string;
  totalCents: number;
  deliveryFeeCents: number;
  timingMessage: string;
  kitchenTimingLabel: string;
  scheduledFor: string | null;
  promotions: Array<{ label: string; discountCents: number }>;
  orderItemIds: string[];
  loyalty: Array<{ label: string; discountCents: number }>;
  reopened?: boolean;
  checkoutOnly?: boolean;
  checkId?: string | null;
  paymentQueue?: boolean;
};
type ReopenedOrderItem = {
  id: string;
  item_name_snapshot: string;
  variant_name_snapshot?: string | null;
  quantity: number;
  cancelled_quantity?: number;
  line_total_cents: number;
  special_instructions?: string | null;
  modifiers?: Array<{ id: string; option_name_snapshot?: string | null; name_snapshot?: string | null; print_on_ticket?: boolean }>;
};
type OpenTikiTab = {
  id: string;
  display_number: string;
  tab_name: string;
  total_cents: number;
  paid_cents: number;
  amount_due_cents: number;
  item_count: number;
  updated_at: string;
};
type LoyaltyStatus = {
  programId: string;
  name: string;
  units: number;
  quantityRequired: number;
  progress: number;
  rewardsAvailable: number;
};

type SubmittedOrder = {
  displayNumber: string;
  totalCents: number;
};
type CheckoutState = {
  order: {
    payment_status: string;
    total_cents: number;
    paid_cents: number;
    amount_due_cents: number;
  };
  check?: {
    id: string;
    display_sequence: number;
    status: string;
    total_cents: number;
    paid_cents: number;
    amount_due_cents: number;
  } | null;
  tenders: Array<{
    id: string;
    tender_type: string;
    transaction_type: string;
    amount_cents: number;
    amount_tendered_cents: number;
    change_due_cents: number;
    status: string;
    related_transaction_id?: string | null;
    reason?: string;
  }>;
};
type HelcimStatus = { checkoutEnabled: boolean; apiTokenConfigured: boolean; localDevelopment?: boolean };
type PosStationProfile = { name:string;station_key:string;station_mode:"payment"|"order_taker";receipt_printer_id?:string|null;payment_terminal_id?:string|null };
type PayableCheck = {
  id: string;
  display_sequence: number;
  status: string;
  total_cents: number;
  paid_cents: number;
  amount_due_cents: number;
  lines: Array<{
    order_item_id: string;
    quantity: number;
    allocated_cents: number;
    item_name_snapshot: string;
  }>;
};

type AddressSuggestion = {
  id: string;
  text: string;
  mainText: string;
  secondaryText: string;
  provider: "google" | "preset";
  deliveryLocationId?: string;
};
type ValidatedAddress = {
  formattedAddress: string;
  city: string;
  state: string;
  postalCode: string;
};
type DeliveryRoute = {
  distanceMiles: number;
  durationSeconds: number;
  provider: string;
  calculatedAt: string;
};
type PosCustomerPhone = {
  id: string;
  label: string;
  display_phone: string;
  normalized_phone: string;
  is_primary: boolean;
  last_used_at: string | null;
};
type PosCustomerAddress = {
  id: string;
  label: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  postal_code: string;
  standardized_address: string;
  provider: string;
  provider_reference_id: string;
  latitude: number | null;
  longitude: number | null;
  is_primary: boolean;
  last_used_at: string | null;
};
type PosCustomer = {
  id: string;
  first_name: string;
  last_name: string;
  display_name: string;
  display_phone: string;
  normalized_phone: string;
  last_order_at: string | null;
  phones: PosCustomerPhone[];
  addresses: PosCustomerAddress[];
};
type BarcodeMapping = {
  id: string;
  barcode: string;
  itemId: string;
  variantId: string | null;
  itemName: string;
  variantName: string | null;
};
type IncomingDeliCall = {
  id: string;
  call_id: string;
  caller_phone: string;
  line_number: string;
  started_at: string;
  customer_id: string | null;
  display_name: string | null;
  open_order_id: string | null;
  open_order_number: string | null;
  open_order_status: string | null;
};
type AiDeliCall = IncomingDeliCall & {
  called_did: string;
  state: "ai" | "handoff_pending" | "human";
  handoff_reason: string;
  updated_at: string;
  claimed_by: string;
  claimed_at: string | null;
  service_type: string | null;
  subtotal_cents: number | null;
  tax_cents: number | null;
  total_cents: number | null;
  activities: Array<{
    id: string;
    createdAt: string;
    role: "customer" | "assistant" | "tool" | "system" | "error";
    label: string;
    detail: string;
    durationMs: number | null;
  }>;
  order_items: Array<{
    id: string;
    name: string;
    variant: string;
    quantity: number;
    lineTotalCents: number;
    instructions: string;
    modifiers: Array<{ name: string; quantity: number }>;
  }>;
};

const DELIVERY_LOCATIONS = [
  {
    id: "ogdensburg-bowl",
    name: "Ogdensburg Bowl",
    address: "1121 Paterson Street, Ogdensburg, NY 13669",
    aliases: [
      "ogdensburg bowl",
      "bowling alley",
      "1121 paterson",
      "1121 patterson",
    ],
    dropoffs: [
      ...Array.from({ length: 14 }, (_, index) => `Lane ${index + 1}`),
      "Bar",
    ],
  },
  {
    id: "claxton-hepburn",
    name: "Claxton-Hepburn Medical Center",
    address: "214 King Street, Ogdensburg, NY 13669",
    aliases: ["claxton", "claxton hepburn", "hospital", "214 king"],
    dropoffs: ["ICU", "ER", "Front Desk"],
  },
  {
    id: "ansen",
    name: "Ansen Corporation",
    address: "100 Chimney Point Drive, Ogdensburg, NY 13669",
    aliases: ["ansen", "new ansen", "old ansen", "100 chimney point"],
    dropoffs: ["New Ansen", "Old Ansen"],
  },
] as const;

function deliveryLocationSuggestions(input: string): AddressSuggestion[] {
  const query = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (query.length < 2) return [];
  return DELIVERY_LOCATIONS.filter((location) =>
    [location.name, location.address, ...location.aliases].some((value) =>
      value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .includes(query),
    ),
  ).map((location) => ({
    id: `preset:${location.id}`,
    text: location.address,
    mainText: location.name,
    secondaryText: `${location.address} · Choose drop-off location`,
    provider: "preset",
    deliveryLocationId: location.id,
  }));
}

function deliBusinessDate(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

const serviceLabels: Record<
  PosServiceType,
  { label: string; paymentNote?: string }
> = {
  pickup: { label: "Pickup" },
  delivery: { label: "Delivery" },
  no_contact_delivery: { label: "No-contact", paymentNote: "Prepay online" },
  dine_in: { label: "Dine In" },
  curbside: { label: "Curbside", paymentNote: "Prepay online" },
  bar: { label: "Bar / Tab" },
};

const utilityLabels: Record<PosUtility, string> = {
  orders: "Orders",
  cash_drawer: "Cash Drawer",
  drivers: "Drivers",
  bar_tabs: "Bar Tabs",
  inventory: "Inventory",
  reports: "Reports",
  manager: "Manager",
};

function money(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

function cloneSelections(
  value: Record<string, string[]>,
): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(value).map(([key, ids]) => [key, [...ids]]),
  );
}

function clientId(): string {
  const bytes = new Uint8Array(16);
  window.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function variantOptionPrice(
  variant: OrderingItemVariantView | null,
  option: OrderingModifierOptionView,
): number {
  const override = variant?.modifierPrices.find(
    (price) => price.optionId === option.id,
  );
  return override ? override.priceDeltaCents : option.priceDeltaCents;
}

function variantOptionAvailable(
  variant: OrderingItemVariantView | null,
  option: OrderingModifierOptionView,
): boolean {
  const override = variant?.modifierPrices.find(
    (price) => price.optionId === option.id,
  );
  return option.available && (override ? override.available : true);
}

function initialVariant(
  item: OrderingMenuItemWithVariants,
): OrderingItemVariantView | null {
  if (!item.variants.length) return null;
  return (
    item.variants.find(
      (variant) => variant.defaultVariant && variant.available,
    ) ||
    (item.variants.length === 1 && item.variants[0].available
      ? item.variants[0]
      : null)
  );
}

function initialModifierSelections(
  item: OrderingMenuItemWithVariants,
  variant: OrderingItemVariantView | null,
): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const group of item.modifiers) {
    result[group.id] = group.options
      .filter(
        (option) =>
          option.defaultSelected && variantOptionAvailable(variant, option),
      )
      .map((option) => option.id);
  }
  return result;
}

function selectionsValid(
  group: OrderingModifierGroupView,
  selections: string[],
): boolean {
  const count = selections.length;
  return count >= group.minSelections && count <= group.maxSelections;
}

export default function PosClient({
  business,
  idleLockSeconds = 60,
  embedded = false,
  initialServiceType,
  tableSessionId,
}: {
  business: Business;
  idleLockSeconds?: number;
  embedded?: boolean;
  initialServiceType?: PosServiceType;
  tableSessionId?: string;
}) {
  const config = orderingBusinessConfig(business);
  const availableServices = config.serviceTypes.filter(
    (value): value is PosServiceType =>
      value !== "undecided" &&
      (business !== "Corner Deli" ||
        value === "pickup" ||
        value === "delivery" ||
        value === "dine_in"),
  );
  const [session, setSession] = useState<SessionView | PosSessionView | null>(
    null,
  );
  const [menu, setMenu] = useState<OrderingMenuCategoryWithVariants[]>([]);
  const [menuLoading, setMenuLoading] = useState(true);
  const [menuError, setMenuError] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [primaryCategoryId, setPrimaryCategoryId] = useState("");
  const [menuSearch, setMenuSearch] = useState("");
  const [serviceType, setServiceType] = useState<PosServiceType>(
    initialServiceType && availableServices.includes(initialServiceType)
      ? initialServiceType
      : availableServices[0] || "pickup",
  );
  const [timingMode, setTimingMode] = useState<OrderTimingMode>("asap");
  const [scheduledFor, setScheduledFor] = useState("");
  const [futureDate, setFutureDate] = useState(() => deliBusinessDate());
  const [futureSlots, setFutureSlots] = useState<string[]>([]);
  const [futureSlotsLoading, setFutureSlotsLoading] = useState(false);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [configuringItem, setConfiguringItem] =
    useState<OrderingMenuItemWithVariants | null>(null);
  const [selectedVariantId, setSelectedVariantId] = useState("");
  const [modifierSelections, setModifierSelections] = useState<
    Record<string, string[]>
  >({});
  const [modifierQuantities, setModifierQuantities] = useState<
    Record<string, number>
  >({});
  const [modifierAmounts, setModifierAmounts] = useState<
    Record<string, "light" | "normal" | "heavy">
  >({});
  const [intensityChoice, setIntensityChoice] = useState<{
    group: OrderingModifierGroupView;
    option: OrderingModifierOptionView;
  } | null>(null);
  const holdTimer = useRef<number | null>(null),
    held = useRef(false);
  const [modifierDeclines, setModifierDeclines] = useState<string[]>([]);
  const [pizzaToppings, setPizzaToppings] = useState<PizzaToppingSelection[]>(
    [],
  );
  const [selectedComboId, setSelectedComboId] = useState("");
  const [comboSelections, setComboSelections] = useState<
    Record<string, string[]>
  >({});
  const [presentationComboEnabled, setPresentationComboEnabled] =
    useState(false);
  const [specialInstructions, setSpecialInstructions] = useState("");
  const [editingLineId, setEditingLineId] = useState<string | null>(null);
  const [savingDraft, setSavingDraft] = useState(false);
  const [checkoutError, setCheckoutError] = useState("");
  const [overrideReason, setOverrideReason] = useState("");
  const [savedDraft, setSavedDraft] = useState<SavedDraft | null>(null);
  const [reopenedItems, setReopenedItems] = useState<ReopenedOrderItem[]>([]);
  const [reopenedCancelItem, setReopenedCancelItem] = useState<ReopenedOrderItem | null>(null);
  async function refreshReopenedOrder(orderId: string) {
    const response = await fetch(`/api/ordering/order-center/${encodeURIComponent(orderId)}`, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok || !payload.order) throw new Error(payload.error || "Could not load the reopened order.");
    setReopenedItems(payload.order.items || []);
    setSavedDraft((current) => current?.id === orderId ? {
      ...current,
      totalCents: Number(payload.order.total_cents),
      deliveryFeeCents: Number(payload.order.delivery_fee_cents || 0),
    } : current);
  }
  function invalidateEditableDraft() {
    setSavedDraft((current) => current?.reopened ? current : null);
  }
  useEffect(() => {
    if (business !== "Corner Deli") return;
    const load = () => {
      try {
        const raw = localStorage.getItem("corner-ops-reopened-order");
        if (!raw) return;
        const value = JSON.parse(raw);
        setSavedDraft({
          ...value,
          promotions: [],
          loyalty: [],
          reopened: true,
        });
        setServiceType(value.serviceType || "pickup");
        setCart([]);
        void refreshReopenedOrder(value.id).catch((error) =>
          setCheckoutError(error instanceof Error ? error.message : "Could not load the reopened order."),
        );
        setCartNotice(
          `Order #${value.displayNumber} reopened. Existing items are locked; swipe or tap VOID to cancel one.`,
        );
      } catch {
        /* Ignore a damaged local handoff value. */
      }
    };
    load();
    window.addEventListener("corner-ops-order-reopened", load);
    return () => window.removeEventListener("corner-ops-order-reopened", load);
  }, [business]);
  useEffect(() => {
    if (business !== "Corner Deli") return;
    const load = () => {
      try {
        const raw = localStorage.getItem("corner-ops-checkout-order");
        if (!raw) return;
        const value = JSON.parse(raw) as SavedDraft;
        if (!value.id || !value.displayNumber) return;
        localStorage.removeItem("corner-ops-checkout-order");
        const checkoutDraft: SavedDraft = {
          ...value,
          promotions: value.promotions || [],
          loyalty: value.loyalty || [],
          orderItemIds: value.orderItemIds || [],
          checkoutOnly: true,
        };
        setSavedDraft(checkoutDraft);
        setCart([]);
        void openCheckout(checkoutDraft);
      } catch {
        localStorage.removeItem("corner-ops-checkout-order");
      }
    };
    load();
    window.addEventListener("corner-ops-checkout-order", load);
    return () => window.removeEventListener("corner-ops-checkout-order", load);
  }, [business]);
  const [quotedPromotions, setQuotedPromotions] = useState<
    Array<{ label: string; discountCents: number }>
  >([]);
  const [submittingOrder, setSubmittingOrder] = useState(false);
  const [submittedOrder, setSubmittedOrder] = useState<SubmittedOrder | null>(
    null,
  );
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [checkoutState, setCheckoutState] = useState<CheckoutState | null>(
    null,
  );
  const [payableChecks, setPayableChecks] = useState<PayableCheck[]>([]);
  const [selectedCheckId, setSelectedCheckId] = useState<string | null>(null);
  const [cashTender, setCashTender] = useState("");
  const [receiptPrinters, setReceiptPrinters] = useState<
    Array<{
      id: string;
      name: string;
      tillKey: string;
      cashDrawerEnabled: boolean;
    }>
  >([]);
  const [receiptPrinterId, setReceiptPrinterId] = useState("");
  const [lastChangeDueCents, setLastChangeDueCents] = useState<number | null>(
    null,
  );
  const [giftCardNumber, setGiftCardNumber] = useState("");
  const giftCardInputRef = useRef<HTMLInputElement>(null);
  const [tipPromptOpen, setTipPromptOpen] = useState(false);
  const [customTip, setCustomTip] = useState("");
  const [paymentBusy, setPaymentBusy] = useState(false);
  const [helcimOpen, setHelcimOpen] = useState(false);
  const [helcimStatus, setHelcimStatus] = useState<HelcimStatus | null>(null);
  const [stationProfile,setStationProfile]=useState<PosStationProfile|null>(null);
  useEffect(() => {
    if (business !== "Corner Deli") return;
    fetch("/api/ordering/hardware/status", { cache: "no-store" })
      .then((response) => response.json())
      .then((body) => {
        const printers = Array.isArray(body.receiptPrinters)
          ? body.receiptPrinters
          : [];
        setReceiptPrinters(printers);
        const stored = localStorage.getItem("corner-ops-receipt-printer") || "";
        setReceiptPrinterId(
          printers.some((printer: any) => printer.id === stored)
            ? stored
            : printers[0]?.id || "",
        );
      })
      .catch(() => setReceiptPrinters([]));
    fetch("/api/ordering/orders/status/payments/helcim", { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Helcim status unavailable.");
        return body;
      })
      .then((body) => setHelcimStatus(body as HelcimStatus))
      .catch(() =>
        setHelcimStatus({ checkoutEnabled: false, apiTokenConfigured: false }),
      );
  }, [business]);
  useEffect(()=>{if(business!=="Corner Deli")return;const stationKey=localStorage.getItem("corner-ops-station-key")||"";fetch(`/api/ordering/payment-stations?stationKey=${encodeURIComponent(stationKey)}`,{cache:"no-store"}).then(response=>response.json()).then(body=>setStationProfile(body.profile||null)).catch(()=>setStationProfile(null))},[business]);
  useEffect(()=>{if(stationProfile?.station_mode==="payment"&&stationProfile.receipt_printer_id&&receiptPrinters.some(printer=>printer.id===stationProfile.receipt_printer_id))setReceiptPrinterId(stationProfile.receipt_printer_id)},[stationProfile,receiptPrinters]);
  const [configurationMessage, setConfigurationMessage] = useState("");
  const [cartNotice, setCartNotice] = useState("");
  const [removedLine, setRemovedLine] = useState<CartLine | null>(null);
  const swipeStart = useRef<{ id: string; x: number; y: number } | null>(null);
  const [deliveryAddress, setDeliveryAddress] = useState("");
  const [deliveryUnit, setDeliveryUnit] = useState("");
  const [selectedDeliveryLocationId, setSelectedDeliveryLocationId] =
    useState("");
  const [addressSessionToken, setAddressSessionToken] = useState("");
  const [addressSuggestions, setAddressSuggestions] = useState<
    AddressSuggestion[]
  >([]);
  const [addressLoading, setAddressLoading] = useState(false);
  const [addressError, setAddressError] = useState("");
  const [activeSuggestion, setActiveSuggestion] = useState(-1);
  const [validatingAddress, setValidatingAddress] = useState(false);
  const [validatedAddress, setValidatedAddress] =
    useState<ValidatedAddress | null>(null);
  const [deliveryValidationToken, setDeliveryValidationToken] = useState("");
  const [deliveryValidatedInput, setDeliveryValidatedInput] = useState("");
  const [deliveryRoute, setDeliveryRoute] = useState<DeliveryRoute | null>(
    null,
  );
  const [quotedDeliveryFeeCents, setQuotedDeliveryFeeCents] = useState<
    number | null
  >(null);
  const [deliveryEditorOpen, setDeliveryEditorOpen] = useState(false);
  const [customer, setCustomer] = useState<PosCustomer | null>(null),
    [customerOpen, setCustomerOpen] = useState(false),
    [customerQuery, setCustomerQuery] = useState(""),
    [customerMatches, setCustomerMatches] = useState<PosCustomer[]>([]);
  const [quickCustomer, setQuickCustomer] = useState({
      firstName: "",
      lastName: "",
      phone: "",
    }),
    [quickCustomerBusy, setQuickCustomerBusy] = useState(false),
    [quickCustomerError, setQuickCustomerError] = useState("");
  const [selectedCustomerPhoneId, setSelectedCustomerPhoneId] = useState("");
  const [selectedCustomerAddressId, setSelectedCustomerAddressId] =
    useState("");
  const [orderOrigin, setOrderOrigin] = useState<"pos" | "phone">("pos");
  const [loyalty, setLoyalty] = useState<LoyaltyStatus[]>([]),
    [redeeming, setRedeeming] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [scanNotice, setScanNotice] = useState("");
  const [unknownBarcode, setUnknownBarcode] = useState("");
  const [incomingCall, setIncomingCall] = useState<IncomingDeliCall | null>(
    null,
  );
  const [aiCalls, setAiCalls] = useState<AiDeliCall[]>([]);
  const [posEmployeeId, setPosEmployeeId] = useState("");
  const intervention = aiCalls.find((call) => call.state !== "ai") || null;
  const [mappingItemId, setMappingItemId] = useState("");
  const [mappingVariantId, setMappingVariantId] = useState("");
  const [mappingBusy, setMappingBusy] = useState(false);
  const [tabName, setTabName] = useState("");
  const [openTabs, setOpenTabs] = useState<OpenTikiTab[]>([]);
  const [tabsOpen, setTabsOpen] = useState(false);
  const [tabsLoading, setTabsLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<SavedDraft | null>(null);
  const [activeTabItems, setActiveTabItems] = useState<
    Array<{
      id: string;
      item_name_snapshot: string;
      variant_name_snapshot: string;
      quantity: number;
      line_total_cents: number;
    }>
  >([]);

  useEffect(() => {
    document.documentElement.dataset.businessTheme = business;
    window.localStorage.setItem("corner-ops-business-theme", business);
    fetch(
      business === "Corner Deli" ? "/api/pos/session" : "/api/auth/session",
      { cache: "no-store" },
    )
      .then((response) => response.json())
      .then((payload: SessionView | PosSessionView) => setSession(payload))
      .catch(() => setSession({ authenticated: false } as SessionView));
  }, [business]);

  useEffect(() => {
    if (!addressSessionToken) setAddressSessionToken(clientId());
  }, [addressSessionToken]);
  useEffect(() => {
    if (business !== "Corner Deli" || !session?.authenticated) return;
    let stopped = false;
    const load = () =>
      fetch("/api/ordering/calls", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((body) => {
          if (!stopped) {
            setIncomingCall(body?.calls?.[0] || null);
            setAiCalls(body?.aiCalls || []);
            setPosEmployeeId(body?.employeeId || "");
          }
        })
        .catch(() => undefined);
    void load();
    const timer = window.setInterval(load, 2000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [business, session?.authenticated]);
  useEffect(() => {
    if (!customerOpen || customerQuery.trim().length < 3) {
      setCustomerMatches([]);
      return;
    }
    const controller = new AbortController(),
      timer = window.setTimeout(
        () =>
          fetch(
            `/api/ordering/customers?q=${encodeURIComponent(customerQuery)}`,
            { signal: controller.signal },
          )
            .then((r) => r.json())
            .then((b) => setCustomerMatches(b.customers || []))
            .catch(() => undefined),
        150,
      );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [customerOpen, customerQuery]);
  useEffect(() => {
    if (!customer) {
      setLoyalty([]);
      return;
    }
    const controller = new AbortController();
    fetch(
      `/api/ordering/loyalty/status?customerId=${encodeURIComponent(customer.id)}`,
      { signal: controller.signal },
    )
      .then((r) => r.json())
      .then((body) => setLoyalty(body.programs || []))
      .catch(() => setLoyalty([]));
    return () => controller.abort();
  }, [customer]);
  useEffect(() => {
    if (timingMode !== "future" || business !== "Corner Deli") return;
    const controller = new AbortController();
    setFutureSlotsLoading(true);
    fetch(
      `/api/ordering/availability?serviceType=${encodeURIComponent(serviceType)}&date=${futureDate}`,
      { cache: "no-store", signal: controller.signal },
    )
      .then((response) => response.json())
      .then((payload) =>
        setFutureSlots(Array.isArray(payload.slots) ? payload.slots : []),
      )
      .catch(() => setFutureSlots([]))
      .finally(() => setFutureSlotsLoading(false));
    return () => controller.abort();
  }, [business, futureDate, serviceType, timingMode]);

  function applyLock() {
    setSession({ authenticated: false });
    window.dispatchEvent(new Event("corner-ops-pos-locked"));
  }
  const { lock: lockPos } = usePosIdleLock({
    authenticated: Boolean(
      session?.authenticated && business === "Corner Deli",
    ),
    seconds: idleLockSeconds,
    onLock: applyLock,
  });

  useEffect(() => {
    if (business !== "Corner Deli") return;
    const requestLock = () => lockPos();
    const authenticated = (event: Event) => {
      const employee = (event as CustomEvent<PosEmployeeSession>).detail;
      if (employee?.employeeId)
        setSession({ authenticated: true, session: employee });
    };
    const attachCustomer = (event: Event) => {
      const selected = (event as CustomEvent<PosCustomer>).detail;
      if (!selected?.id) return;
      chooseCustomer(selected);
      setSavedDraft(null);
      setCartNotice(`${selected.display_name} attached to current order`);
    };
    const focusProductSearch = () => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    };
    window.addEventListener("corner-ops-pos-lock-request", requestLock);
    window.addEventListener("corner-ops-pos-authenticated", authenticated);
    window.addEventListener("corner-ops-pos-customer-selected", attachCustomer);
    window.addEventListener(
      "corner-ops-pos-product-search",
      focusProductSearch,
    );
    return () => {
      window.removeEventListener("corner-ops-pos-lock-request", requestLock);
      window.removeEventListener("corner-ops-pos-authenticated", authenticated);
      window.removeEventListener(
        "corner-ops-pos-customer-selected",
        attachCustomer,
      );
      window.removeEventListener(
        "corner-ops-pos-product-search",
        focusProductSearch,
      );
    };
  }, [business, lockPos]);

  useEffect(() => {
    if (!session?.authenticated) return;
    let cancelled = false;
    setMenuLoading(true);
    setMenuError("");
    const menuTime =
      timingMode === "future" && scheduledFor
        ? `&scheduledFor=${encodeURIComponent(scheduledFor)}`
        : "";
    fetch(
      `/api/ordering/menu?business=${encodeURIComponent(business)}${menuTime}`,
      { cache: "no-store" },
    )
      .then(async (response) => {
        const payload = (await response.json()) as MenuPayload & {
          error?: string;
        };
        if (!response.ok)
          throw new Error(payload.error || "Could not load menu.");
        return payload;
      })
      .then((payload) => {
        if (cancelled) return;
        setMenu(payload.categories || []);
        const primaries = payload.categories.filter(
          (category) => !category.parentId,
        );
        const firstPrimary = primaries.find(
          (category) =>
            category.items.length ||
            payload.categories.some((child) => child.parentId === category.id),
        );
        const firstLeaf = firstPrimary?.presentationOnly
          ? payload.categories.find(
              (child) => child.parentId === firstPrimary.id,
            )
          : firstPrimary;
        setPrimaryCategoryId((current) =>
          primaries.some((category) => category.id === current)
            ? current
            : firstPrimary?.id || "",
        );
        setCategoryId((current) =>
          payload.categories.some((category) => category.id === current)
            ? current
            : firstLeaf?.id || "",
        );
      })
      .catch((error) => {
        if (!cancelled)
          setMenuError(
            error instanceof Error ? error.message : "Could not load menu.",
          );
      })
      .finally(() => {
        if (!cancelled) setMenuLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [business, scheduledFor, session?.authenticated, timingMode]);

  useEffect(() => {
    if (serviceType !== "delivery") return;
    const input = deliveryAddress.trim();
    if (input.length < 2 || validatedAddress) {
      setAddressSuggestions([]);
      setAddressLoading(false);
      return;
    }
    const presetSuggestions = deliveryLocationSuggestions(input);
    setAddressSuggestions(presetSuggestions);
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setAddressLoading(true);
      setAddressError("");
      fetch("/api/ordering/address/suggest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({ input, sessionToken: addressSessionToken }),
      })
        .then(async (response) => {
          const payload = (await response.json()) as {
            suggestions?: AddressSuggestion[];
            error?: string;
          };
          if (!response.ok)
            throw new Error(
              payload.error || "Address suggestions are unavailable.",
            );
          return payload;
        })
        .then((payload) => {
          setAddressSuggestions([
            ...presetSuggestions,
            ...(payload.suggestions || []),
          ]);
          setActiveSuggestion(-1);
        })
        .catch((error) => {
          if (error instanceof DOMException && error.name === "AbortError")
            return;
          setAddressSuggestions(presetSuggestions);
          if (!presetSuggestions.length)
            setAddressError(
              error instanceof Error
                ? error.message
                : "Address suggestions are unavailable.",
            );
        })
        .finally(() => setAddressLoading(false));
    }, 220);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [addressSessionToken, deliveryAddress, serviceType, validatedAddress]);

  const primaryCategories = useMemo(
    () =>
      menu.filter(
        (category) =>
          !category.parentId &&
          (category.items.length ||
            menu.some((child) => child.parentId === category.id)),
      ),
    [menu],
  );
  const activePrimary =
    primaryCategories.find((category) => category.id === primaryCategoryId) ||
    primaryCategories[0];
  const subcategories = activePrimary
    ? menu.filter((category) => category.parentId === activePrimary.id)
    : [];
  const activeCategory =
    menu.find((category) => category.id === categoryId) ||
    (activePrimary?.presentationOnly ? subcategories[0] : activePrimary);
  const allItems = useMemo(
    () => menu.flatMap((category) => category.items),
    [menu],
  );

  async function handleScan(value: string) {
    if (!session?.authenticated) return;
    if (checkoutOpen) {
      setGiftCardNumber(giftCardNumberFromInput(value));
      setCheckoutError("");
      setScanNotice(
        "Gift card scanned. Review the card and choose Apply Gift Card.",
      );
      return;
    }
    try {
      const response = await fetch(
        `/api/ordering/barcodes?business=${encodeURIComponent(business)}&barcode=${encodeURIComponent(value)}`,
        { cache: "no-store" },
      );
      const payload = (await response.json()) as {
        mapping?: BarcodeMapping | null;
        error?: string;
      };
      if (!response.ok)
        throw new Error(payload.error || "Barcode could not be read.");
      if (!payload.mapping) {
        setUnknownBarcode(value);
        setMappingItemId("");
        setMappingVariantId("");
        setScanNotice(`Unknown barcode: ${value}`);
        return;
      }
      const item = allItems.find(
        (candidate) => candidate.id === payload.mapping!.itemId,
      );
      if (!item || !item.available) {
        setScanNotice(`${payload.mapping.itemName} is currently unavailable.`);
        return;
      }
      if (itemNeedsConfiguration(item)) {
        openItem(item);
        if (payload.mapping.variantId)
          setSelectedVariantId(payload.mapping.variantId);
        setScanNotice(
          `Scanned ${payload.mapping.itemName}${payload.mapping.variantName ? ` · ${payload.mapping.variantName}` : ""}. Complete required choices.`,
        );
      } else {
        selectItem(item);
        setScanNotice(`Scanned and added ${payload.mapping.itemName}.`);
      }
    } catch (error) {
      setScanNotice(
        error instanceof Error ? error.message : "Barcode could not be read.",
      );
    }
  }

  useEffect(() => {
    if (!session?.authenticated) return;
    const detector = new KeyboardWedgeDetector(
      (capture) => void handleScan(capture.value),
    );
    const listener = (event: KeyboardEvent) => {
      const giftInput =
        (event.target as HTMLElement | null)?.dataset?.barcodeContext ===
        "gift-card";
      if (isHumanTextEntry(event.target) && !giftInput) {
        detector.reset();
        return;
      }
      if (detector.key(event.key, event.timeStamp) && event.key === "Enter")
        event.preventDefault();
    };
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  }, [session?.authenticated, checkoutOpen, business, allItems]);

  async function mapUnknownBarcode() {
    const item = allItems.find((candidate) => candidate.id === mappingItemId);
    if (!item || !unknownBarcode) return;
    setMappingBusy(true);
    try {
      const response = await fetch("/api/ordering/barcodes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          business,
          barcode: unknownBarcode,
          itemId: item.id,
          variantId: mappingVariantId || null,
        }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok)
        throw new Error(payload.error || "Could not save barcode mapping.");
      setScanNotice(
        `Mapped ${unknownBarcode} to ${item.name}. Scan it again to add.`,
      );
      setUnknownBarcode("");
    } catch (error) {
      setScanNotice(
        error instanceof Error
          ? error.message
          : "Could not save barcode mapping.",
      );
    } finally {
      setMappingBusy(false);
    }
  }
  const visibleItems = useMemo(() => {
    const query = menuSearch.trim().toLowerCase();
    if (!query) return activeCategory?.items || [];
    return allItems.filter((item) =>
      [
        item.name,
        item.description,
        ...item.variants.flatMap((variant) => [
          variant.name,
          ...variant.aliases,
        ]),
      ].some((value) => value.toLowerCase().includes(query)),
    );
  }, [activeCategory, allItems, menuSearch]);
  const subtotalCents = cart.reduce(
    (sum, line) => sum + line.unitPriceCents * line.quantity,
    0,
  );
  useEffect(() => {
    if (business !== "Corner Deli") return;
    const payload = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      serviceType,
      lines: cart.map((line) => ({
        id: line.id,
        name: line.name,
        variantName: line.variantName,
        quantity: line.quantity,
        modifiers: [...line.modifierText, ...line.comboText],
        lineTotalCents: line.unitPriceCents * line.quantity,
      })),
      subtotalCents,
      totalCents: savedDraft?.totalCents ?? subtotalCents,
      status: submittedOrder
        ? "submitted"
        : checkoutOpen
          ? "checkout"
          : "building",
      orderNumber:
        submittedOrder?.displayNumber || savedDraft?.displayNumber || "",
    };
    localStorage.setItem(
      "corner-ops-customer-display",
      JSON.stringify(payload),
    );
    const channel = new BroadcastChannel("corner-ops-customer-display");
    channel.postMessage(payload);
    channel.close();
  }, [
    business,
    cart,
    checkoutOpen,
    savedDraft?.displayNumber,
    savedDraft?.totalCents,
    serviceType,
    submittedOrder,
    subtotalCents,
  ]);
  useEffect(() => {
    if (serviceType !== "delivery" || !deliveryRoute || !cart.length) {
      setQuotedDeliveryFeeCents(null);
      return;
    }
    const controller = new AbortController(),
      timer = window.setTimeout(
        () =>
          fetch("/api/ordering/delivery/quote", {
            method: "POST",
            headers: { "content-type": "application/json" },
            signal: controller.signal,
            body: JSON.stringify({
              business,
              distanceMiles: deliveryRoute.distanceMiles,
              merchandiseSubtotalCents: subtotalCents,
            }),
          })
            .then(async (response) => {
              const payload = await response.json();
              if (response.status === 401) {
                window.dispatchEvent(new Event("corner-ops-pos-locked"));
                throw new Error(
                  "POS session expired. Unlock to continue this delivery order.",
                );
              }
              if (!response.ok)
                throw new Error(
                  payload.error || "Could not calculate the delivery fee.",
                );
              setQuotedDeliveryFeeCents(Number(payload.quote.deliveryFeeCents));
              setAddressError("");
            })
            .catch((error) => {
              if (!(
                error instanceof DOMException && error.name === "AbortError"
              )) {
                setQuotedDeliveryFeeCents(null);
                setAddressError(
                  error instanceof Error
                    ? error.message
                    : "Could not calculate the delivery fee.",
                );
              }
            }),
        150,
      );
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [business, deliveryRoute, serviceType, subtotalCents, cart.length]);
  useEffect(() => {
    if (!cart.length) {
      setQuotedPromotions([]);
      return;
    }
    const controller = new AbortController(),
      timer = window.setTimeout(() => {
        fetch("/api/ordering/promotions/quote", {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            serviceType,
            fulfillmentAt:
              timingMode === "future" && scheduledFor
                ? new Date(scheduledFor).toISOString()
                : null,
            items: cart.map((line) => {
              const item = allItems.find(
                  (candidate) => candidate.id === line.itemId,
                ),
                variant =
                  item?.variants.find(
                    (candidate) => candidate.id === line.variantId,
                  ) || null;
              const modifiers =
                item?.modifiers.flatMap((group) => {
                  if (group.presentationBehavior === "pizza_topping")
                    return line.pizzaToppings
                      .filter((topping) =>
                        group.options.some(
                          (option) => option.id === topping.modifierOptionId,
                        ),
                      )
                      .map((topping) => {
                        const option = group.options.find(
                          (candidate) =>
                            candidate.id === topping.modifierOptionId,
                        )!;
                        return {
                          groupId: group.id,
                          optionId: option.id,
                          priceCents: pizzaToppingPriceCents(
                            variantOptionPrice(variant, option),
                            topping.portion,
                            topping.amount,
                          ),
                          quantity: 1,
                          intensity: topping.amount,
                        };
                      });
                  const selected = line.modifierSelections[group.id] || [];
                  return group.options
                    .filter((option) => selected.includes(option.id))
                    .map((option, index) => ({
                      groupId: group.id,
                      optionId: option.id,
                      priceCents:
                        group.includedChoiceCount > index &&
                        !line.modifierDeclines.includes(group.id)
                          ? 0
                          : variantOptionPrice(variant, option),
                      quantity: group.allowOptionQuantity
                        ? Math.max(1, line.modifierQuantities[option.id] || 1)
                        : 1,
                      intensity:
                        (line.modifierAmounts[option.id] || "normal") ===
                        "normal"
                          ? "regular"
                          : line.modifierAmounts[option.id],
                    }));
                }) || [];
              return {
                lineId: line.id,
                itemId: line.itemId,
                variantId: line.variantId,
                quantity: line.quantity,
                modifiers,
              };
            }),
          }),
        })
          .then((response) => response.json())
          .then((payload) => setQuotedPromotions(payload.promotions || []))
          .catch((error) => {
            if (!(error instanceof DOMException && error.name === "AbortError"))
              setQuotedPromotions([]);
          });
      }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [allItems, cart, scheduledFor, serviceType, timingMode]);
  const visiblePromotions = savedDraft?.promotions || quotedPromotions,
    promotionDiscountCents = visiblePromotions.reduce(
      (sum, row) => sum + row.discountCents,
      0,
    );
  const selectedCombo =
    configuringItem?.combos.find((combo) => combo.id === selectedComboId) ||
    null;
  const selectedVariant =
    configuringItem?.variants.find(
      (variant) => variant.id === selectedVariantId,
    ) || null;
  const modifierGroupVisible = (group: OrderingModifierGroupView) => {
    if (group.presentationContext === "hidden") return false;
    if (group.presentationContext === "combo_trigger")
      return presentationComboEnabled;
    if (group.presentationContext !== "dependent") return true;
    return (modifierSelections[group.parentGroupId || ""] || []).some((id) =>
      group.parentOptionIds.includes(id),
    );
  };

  const configuration = useMemo(() => {
    if (!configuringItem) {
      return {
        valid: false,
        unitPriceCents: 0,
        modifierText: [] as string[],
        comboText: [] as string[],
        missing: [] as Array<{ id: string; message: string }>,
      };
    }

    const variantRequired = configuringItem.variants.length > 0;
    let valid = !variantRequired || Boolean(selectedVariant);
    let unitPriceCents =
      selectedVariant?.basePriceCents ?? configuringItem.basePriceCents;
    const modifierText: string[] = [];
    const comboText: string[] = [];
    const missing: Array<{ id: string; message: string }> = [];
    if (variantRequired && !selectedVariant)
      missing.push({ id: "variant-choice", message: "Select a size" });

    for (const group of configuringItem.modifiers.filter(
      modifierGroupVisible,
    )) {
      if (group.presentationBehavior === "pizza_topping") continue;
      const selected = modifierSelections[group.id] || [];
      if (!selectionsValid(group, selected)) {
        valid = false;
        missing.push({
          id: `modifier-${group.id}`,
          message: `Choose ${group.minSelections === group.maxSelections ? group.minSelections : `${group.minSelections}-${group.maxSelections}`} ${group.prompt || group.name}`,
        });
      }
      for (const option of group.options) {
        const chosen = selected.includes(option.id);
        const available = variantOptionAvailable(selectedVariant, option);
        const baseDeltaCents = variantOptionPrice(selectedVariant, option);
        const selectedOrdinal = group.options
          .filter((candidate) => selected.includes(candidate.id))
          .findIndex((candidate) => candidate.id === option.id);
        const priceDeltaCents =
          group.includedChoiceCount > 0 &&
          !modifierDeclines.includes(group.id) &&
          selectedOrdinal >= 0 &&
          selectedOrdinal < group.includedChoiceCount
            ? 0
            : baseDeltaCents;
        if (chosen && !available) valid = false;
        if (chosen) {
          const optionQuantity = group.allowOptionQuantity
            ? Math.max(1, modifierQuantities[option.id] || 1)
            : 1;
          unitPriceCents += priceDeltaCents * optionQuantity;
          if (
            !option.defaultSelected ||
            priceDeltaCents !== 0 ||
            (modifierAmounts[option.id] &&
              modifierAmounts[option.id] !== "normal")
          ) {
            modifierText.push(
              `${group.name}: ${formatModifierIntensity(option.name, modifierAmounts[option.id] || "normal")}${optionQuantity > 1 ? ` ×${optionQuantity}` : ""}`,
            );
          }
        } else if (option.defaultSelected) {
          modifierText.push(`${group.name}: NO ${option.name.toUpperCase()}`);
        }
      }
    }

    for (const topping of normalizePizzaToppings(pizzaToppings)) {
      const group = configuringItem.modifiers.find(
        (candidate) =>
          candidate.presentationBehavior === "pizza_topping" &&
          candidate.options.some(
            (option) => option.id === topping.modifierOptionId,
          ),
      );
      const option = group?.options.find(
        (candidate) => candidate.id === topping.modifierOptionId,
      );
      if (!option || !variantOptionAvailable(selectedVariant, option)) {
        valid = false;
        continue;
      }
      unitPriceCents += pizzaToppingPriceCents(
        variantOptionPrice(selectedVariant, option),
        topping.portion,
        topping.amount,
      );
      modifierText.push(
        formatPizzaTopping(option.name, topping.portion, topping.amount),
      );
    }

    if (selectedCombo) {
      unitPriceCents += selectedCombo.basePriceDeltaCents;
      comboText.push(selectedCombo.name);
      for (const group of selectedCombo.groups) {
        const selected = comboSelections[group.id] || [];
        if (
          selected.length < group.minSelections ||
          selected.length > group.maxSelections
        ) {
          valid = false;
          missing.push({
            id: `combo-${group.id}`,
            message: `Choose ${group.minSelections === group.maxSelections ? group.minSelections : `${group.minSelections}-${group.maxSelections}`} ${group.prompt || group.name}`,
          });
        }
        for (const option of group.options.filter((candidate) =>
          selected.includes(candidate.id),
        )) {
          unitPriceCents += option.priceDeltaCents;
          comboText.push(`${group.name}: ${option.name}`);
        }
      }
    }

    return { valid, unitPriceCents, modifierText, comboText, missing };
  }, [
    configuringItem,
    selectedVariant,
    modifierSelections,
    modifierQuantities,
    modifierAmounts,
    pizzaToppings,
    selectedCombo,
    comboSelections,
    presentationComboEnabled,
  ]);

  function openItem(item: OrderingMenuItemWithVariants, line?: CartLine) {
    if (!item.available) return;
    const variant = initialVariant(item);
    setConfiguringItem(item);
    const lineVariant = line?.variantId
      ? item.variants.find((candidate) => candidate.id === line.variantId) ||
        variant
      : variant;
    setSelectedVariantId(lineVariant?.id || "");
    setModifierSelections(
      line
        ? cloneSelections(line.modifierSelections)
        : initialModifierSelections(item, lineVariant),
    );
    setModifierQuantities(line ? { ...line.modifierQuantities } : {});
    setModifierDeclines(line ? [...line.modifierDeclines] : []);
    setModifierAmounts(line ? { ...line.modifierAmounts } : {});
    setPizzaToppings(
      line ? line.pizzaToppings.map((topping) => ({ ...topping })) : [],
    );
    setSelectedComboId(line?.comboId || "");
    setComboSelections(line ? cloneSelections(line.comboSelections) : {});
    setPresentationComboEnabled(
      Boolean(
        line &&
        item.modifiers.some(
          (group) =>
            group.presentationContext === "combo_trigger" &&
            (line.modifierSelections[group.id] || []).length,
        ),
      ),
    );
    setSpecialInstructions(line?.specialInstructions || "");
    setEditingLineId(line?.id || null);
    setCheckoutError("");
    setConfigurationMessage("");
  }

  function selectItem(item: OrderingMenuItemWithVariants) {
    if (itemNeedsConfiguration(item)) {
      openItem(item);
      return;
    }
    const variant = initialVariant(item);
    const line: CartLine = {
      id: clientId(),
      itemId: item.id,
      variantId: variant?.id || null,
      variantName: variant?.name || "",
      name: item.name,
      quantity: 1,
      unitPriceCents: variant?.basePriceCents ?? item.basePriceCents,
      modifierText: [],
      comboText: [],
      modifierSelections: {},
      modifierQuantities: {},
      modifierAmounts: {},
      modifierDeclines: [],
      pizzaToppings: [],
      comboId: null,
      comboSelections: {},
      specialInstructions: "",
    };
    setCart((current) => appendOrIncrementCartLine(current,line));
    invalidateEditableDraft();
    setCartNotice(`Added ${item.name}`);
    window.setTimeout(() => setCartNotice(""), 1800);
  }

  function chooseVariant(variant: OrderingItemVariantView) {
    if (!configuringItem || !variant.available) return;
    setSelectedVariantId(variant.id);
    setModifierSelections((current) => {
      const next: Record<string, string[]> = {};
      for (const group of configuringItem.modifiers) {
        const selected = current[group.id] || [];
        next[group.id] = selected.filter((id) => {
          const option = group.options.find((candidate) => candidate.id === id);
          return Boolean(option && variantOptionAvailable(variant, option));
        });
      }
      return next;
    });
  }

  function toggleModifier(group: OrderingModifierGroupView, optionId: string) {
    if (!configuringItem) return;
    const itemModifiers = configuringItem.modifiers;
    const option = group.options.find((candidate) => candidate.id === optionId);
    if (!option || !variantOptionAvailable(selectedVariant, option)) return;
    setModifierSelections((current) => {
      const existing = current[group.id] || [];
      const next =
        group.maxSelections === 1
          ? {
              ...current,
              [group.id]: existing.includes(optionId) ? [] : [optionId],
            }
          : {
              ...current,
              [group.id]: existing.includes(optionId)
                ? existing.filter((id) => id !== optionId)
                : [...existing, optionId].slice(0, group.maxSelections),
            };
      for (const dependent of itemModifiers.filter(
        (candidate) => candidate.parentGroupId === group.id,
      )) {
        if (
          !(next[group.id] || []).some((id) =>
            dependent.parentOptionIds.includes(id),
          )
        )
          next[dependent.id] = [];
      }
      return next;
    });
    setModifierQuantities((current) => ({
      ...current,
      [optionId]: current[optionId] || 1,
    }));
  }

  function changeModifierQuantity(optionId: string, delta: number) {
    setModifierQuantities((current) => ({
      ...current,
      [optionId]: Math.max(1, Math.min(99, (current[optionId] || 1) + delta)),
    }));
  }

  function beginIntensityHold(
    group: OrderingModifierGroupView,
    option: OrderingModifierOptionView,
  ) {
    if (!supportsSubModifierIntensity(group.supportsIntensity, option.name))
      return;
    held.current = false;
    if (holdTimer.current) window.clearTimeout(holdTimer.current);
    holdTimer.current = window.setTimeout(() => {
      held.current = true;
      setIntensityChoice({ group, option });
    }, 450);
  }
  function endIntensityHold() {
    if (holdTimer.current) window.clearTimeout(holdTimer.current);
    holdTimer.current = null;
  }
  function chooseIntensity(amount: "light" | "normal" | "heavy") {
    if (!intensityChoice) return;
    const { group, option } = intensityChoice;
    setModifierSelections((current) => ({
      ...current,
      [group.id]:
        group.maxSelections === 1
          ? [option.id]
          : Array.from(
              new Set([...(current[group.id] || []), option.id]),
            ).slice(0, group.maxSelections),
    }));
    setModifierAmounts((current) => ({ ...current, [option.id]: amount }));
    setIntensityChoice(null);
  }

  function chooseCombo(combo: OrderingComboView | null) {
    setSelectedComboId(combo?.id || "");
    const defaults: Record<string, string[]> = {};
    if (combo) for (const group of combo.groups) defaults[group.id] = [];
    setComboSelections(defaults);
  }

  function toggleComboOption(
    groupId: string,
    maxSelections: number,
    optionId: string,
  ) {
    setComboSelections((current) => {
      const existing = current[groupId] || [];
      if (maxSelections === 1) {
        return {
          ...current,
          [groupId]: existing.includes(optionId) ? [] : [optionId],
        };
      }
      return {
        ...current,
        [groupId]: existing.includes(optionId)
          ? existing.filter((id) => id !== optionId)
          : [...existing, optionId].slice(0, maxSelections),
      };
    });
  }

  function addConfiguredItem() {
    if (!configuringItem) return;
    if (!configuration.valid) {
      setConfigurationMessage(
        configuration.missing.map((issue) => issue.message).join(" · ") ||
          "Complete the required choices.",
      );
      const first = configuration.missing[0];
      if (first)
        document
          .getElementById(first.id)
          ?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    const line: CartLine = {
      id: editingLineId || clientId(),
      itemId: configuringItem.id,
      variantId: selectedVariant?.id || null,
      variantName: selectedVariant?.name || "",
      name: configuringItem.name,
      quantity: 1,
      unitPriceCents: configuration.unitPriceCents,
      modifierText: configuration.modifierText,
      comboText: configuration.comboText,
      modifierSelections: cloneSelections(modifierSelections),
      modifierQuantities: { ...modifierQuantities },
      modifierAmounts: { ...modifierAmounts },
      modifierDeclines: [...modifierDeclines],
      pizzaToppings: normalizePizzaToppings(pizzaToppings),
      comboId: selectedCombo?.id || null,
      comboSelections: cloneSelections(comboSelections),
      specialInstructions: specialInstructions.trim(),
    };
    setCart((current) =>
      editingLineId
        ? current.map((candidate) =>
            candidate.id === editingLineId ? line : candidate,
          )
        : appendOrIncrementCartLine(current,line),
    );
    setConfiguringItem(null);
    setSelectedVariantId("");
    setEditingLineId(null);
    invalidateEditableDraft();
    setCartNotice(
      `${editingLineId ? "Updated" : "Added"} ${configuringItem.name}`,
    );
    window.setTimeout(() => setCartNotice(""), 1800);
    window.setTimeout(() => searchInputRef.current?.focus(), 0);
  }

  function changeDeliveryAddress(value: string) {
    setDeliveryAddress(value);
    setDeliveryUnit("");
    setSelectedDeliveryLocationId("");
    setSelectedCustomerAddressId("");
    setValidatedAddress(null);
    setDeliveryValidationToken("");
    setDeliveryValidatedInput("");
    setDeliveryRoute(null);
    setAddressError("");
    setSavedDraft(null);
  }

  async function validateAddress(
    suggestion?: AddressSuggestion,
    explicitAddress?: string,
  ) {
    const enteredAddress =
      explicitAddress || suggestion?.text || deliveryAddress;
    if (suggestion) {
      setDeliveryAddress(suggestion.text);
      setSelectedDeliveryLocationId(suggestion.deliveryLocationId || "");
      setDeliveryUnit("");
    }
    setValidatingAddress(true);
    setAddressError("");
    setAddressSuggestions([]);
    try {
      const response = await fetch("/api/ordering/address/validate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enteredAddress,
          placeId:
            suggestion?.provider === "google" ? suggestion.id : undefined,
          sessionToken: addressSessionToken,
        }),
      });
      const payload = (await response.json()) as {
        address?: ValidatedAddress;
        validationToken?: string;
        route?: DeliveryRoute | null;
        error?: string;
      };
      if (!response.ok || !payload.address || !payload.validationToken)
        throw new Error(payload.error || "Could not validate this address.");
      setValidatedAddress(payload.address);
      setDeliveryValidationToken(payload.validationToken);
      setDeliveryValidatedInput(enteredAddress.trim().replace(/\s+/g, " "));
      setDeliveryRoute(payload.route || null);
      setDeliveryAddress(payload.address.formattedAddress);
      setDeliveryEditorOpen(false);
      setAddressSessionToken(clientId());
      setSavedDraft(null);
    } catch (error) {
      setValidatedAddress(null);
      setDeliveryValidationToken("");
      setDeliveryValidatedInput("");
      setDeliveryRoute(null);
      setAddressError(
        error instanceof Error
          ? error.message
          : "Could not validate this address.",
      );
    } finally {
      setValidatingAddress(false);
    }
  }

  function chooseCustomer(next: PosCustomer) {
    setCustomer(next);
    const phone =
      next.phones?.find((candidate) => candidate.is_primary) ||
      next.phones?.[0];
    setSelectedCustomerPhoneId(phone?.id || "");
    setSavedDraft(null);
  }
  async function acknowledgeIncomingCall(useCaller = false) {
    const call = incomingCall;
    if (!call) return;
    if (useCaller) {
      const response = await fetch(
          `/api/ordering/customers?q=${encodeURIComponent(call.caller_phone)}`,
        ),
        body = (await response.json()) as { customers?: PosCustomer[] };
      if (body.customers?.[0]) chooseCustomer(body.customers[0]);
      else {
        setQuickCustomer((current) => ({
          ...current,
          phone: call.caller_phone,
        }));
        setCustomerOpen(true);
      }
    }
    await fetch("/api/ordering/calls", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: call.id }),
    });
    setIncomingCall(null);
  }
  async function updateAiCall(
    call: AiDeliCall,
    action: "claim" | "release" | "complete",
  ) {
    const response = await fetch("/api/ordering/calls", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: call.id, action }),
    });
    const payload = await response.json();
    if (!response.ok) {
      setMenuError(payload.error || "Could not update this call.");
      return;
    }
    if (action === "claim" && call.open_order_id)
      window.location.href = `/pos/deli/orders?orderId=${encodeURIComponent(call.open_order_id)}`;
    setAiCalls((current) =>
      action === "complete"
        ? current.filter((row) => row.id !== call.id)
        : current.map((row) =>
            row.id === call.id
              ? {
                  ...row,
                  state: action === "claim" ? "human" : "handoff_pending",
                  claimed_by: action === "claim" ? posEmployeeId : "",
                }
              : row,
          ),
    );
  }
  async function createQuickCustomer(event: React.FormEvent) {
    event.preventDefault();
    if (quickCustomerBusy) return;
    setQuickCustomerBusy(true);
    setQuickCustomerError("");
    try {
      const response = await fetch("/api/ordering/customers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(quickCustomer),
      });
      const payload = (await response.json()) as {
        customer?: PosCustomer;
        error?: string;
      };
      if ((!response.ok && response.status !== 409) || !payload.customer)
        throw new Error(payload.error || "Could not save this customer.");
      chooseCustomer(payload.customer);
      setQuickCustomer({ firstName: "", lastName: "", phone: "" });
      setCustomerQuery("");
      setCustomerOpen(false);
    } catch (error) {
      setQuickCustomerError(
        error instanceof Error
          ? error.message
          : "Could not save this customer.",
      );
    } finally {
      setQuickCustomerBusy(false);
    }
  }
  async function chooseSavedAddress(address: PosCustomerAddress) {
    setSelectedCustomerAddressId(address.id);
    const entered = [
      address.line1,
      address.line2,
      address.city,
      address.state,
      address.postal_code,
    ]
      .filter(Boolean)
      .join(", ");
    setDeliveryAddress(entered);
    setDeliveryUnit(address.line2 || "");
    await validateAddress(undefined, entered);
  }

  function removeLine(lineId: string) {
    setCart((current) => {
      setRemovedLine(current.find((line) => line.id === lineId) || null);
      return current.filter((line) => line.id !== lineId);
    });
    invalidateEditableDraft();
  }

  function changeQuantity(lineId: string, delta: number) {
    setCart((current) =>
      current
        .map((line) =>
          line.id === lineId
            ? { ...line, quantity: Math.max(0, line.quantity + delta) }
            : line,
        )
        .filter((line) => line.quantity > 0),
    );
    invalidateEditableDraft();
  }

  async function saveDraft(): Promise<SavedDraft | null> {
    if (!cart.length || savingDraft) return null;
    if (timingMode === "future" && !scheduledFor) {
      setCheckoutError(
        "Choose the future pickup/delivery time before saving the order.",
      );
      return null;
    }
    const reopenedDraft = savedDraft?.reopened ? savedDraft : null;
    setSavingDraft(true);
    setCheckoutError("");
    setSavedDraft(reopenedDraft);
    try {
      if (business === "Tiki" && serviceType === "bar" && activeTab) {
        const response = await fetch(
          `/api/ordering/tiki-tabs/${encodeURIComponent(activeTab.id)}/items`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              items: cart.map((line) => ({
                itemId: line.itemId,
                variantId: line.variantId,
                quantity: line.quantity,
                modifierSelections: line.modifierSelections,
                modifierQuantities: line.modifierQuantities,
                modifierAmounts: line.modifierAmounts,
                modifierDeclines: line.modifierDeclines,
                pizzaToppings: line.pizzaToppings,
                comboId: line.comboId,
                comboSelections: line.comboSelections,
                specialInstructions: line.specialInstructions,
              })),
            }),
          },
        );
        const payload = (await response.json()) as {
          tab?: any;
          error?: string;
        };
        if (!response.ok || !payload.tab)
          throw new Error(payload.error || "Could not add items to the tab.");
        const updated = {
          ...activeTab,
          totalCents: Number(payload.tab.total_cents),
        };
        setActiveTab(updated);
        setSavedDraft(updated);
        setActiveTabItems(payload.tab.items || []);
        setCart([]);
        setCartNotice(
          `Added items to tab ${tabName || `#${updated.displayNumber}`}.`,
        );
        return updated;
      }
      const response = await fetch(
        reopenedDraft
          ? `/api/ordering/orders/${encodeURIComponent(reopenedDraft.id)}/additions`
          : "/api/ordering/orders",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            business,
            serviceType,
            timingMode,
            scheduledFor:
              timingMode === "future"
                ? new Date(scheduledFor).toISOString()
                : null,
            deliveryAddress:
              serviceType === "delivery" ? deliveryValidatedInput : undefined,
            deliveryUnit: serviceType === "delivery" ? deliveryUnit : undefined,
            deliveryValidationToken:
              serviceType === "delivery" ? deliveryValidationToken : undefined,
            customerId: customer?.id,
            customerPhoneId: selectedCustomerPhoneId || undefined,
            customerAddressId:
              serviceType === "delivery"
                ? selectedCustomerAddressId || undefined
                : undefined,
            customerFirstName:
              customer?.first_name ||
              (business === "Tiki" && serviceType === "bar"
                ? tabName.trim()
                : undefined),
            customerLastName: customer?.last_name,
            callerPhone:
              customer?.phones?.find(
                (phone) => phone.id === selectedCustomerPhoneId,
              )?.normalized_phone || customer?.normalized_phone,
            orderOrigin,
            tableSessionId,
            items: cart.map((line) => ({
              itemId: line.itemId,
              variantId: line.variantId,
              quantity: line.quantity,
              modifierSelections: line.modifierSelections,
              modifierQuantities: line.modifierQuantities,
              modifierAmounts: line.modifierAmounts,
              modifierDeclines: line.modifierDeclines,
              pizzaToppings: line.pizzaToppings,
              comboId: line.comboId,
              comboSelections: line.comboSelections,
              specialInstructions: line.specialInstructions,
            })),
          }),
        },
      );
      const payload = (await response.json()) as {
        order?: {
          id: string;
          display_number: string;
          total_cents: number;
          delivery_fee_cents: number;
          scheduled_for: string | null;
          timing_message_snapshot: string;
          kitchen_timing_label_snapshot: string;
        };
        promotions?: Array<{ label: string; discount_cents: number }>;
        orderItems?: Array<{ id: string }>;
        error?: string;
      };
      if (!response.ok || !payload.order)
        throw new Error(payload.error || "Could not save draft order.");
      const draft = {
        id: payload.order.id,
        displayNumber: payload.order.display_number,
        totalCents: Number(payload.order.total_cents),
        deliveryFeeCents: Number(payload.order.delivery_fee_cents || 0),
        timingMessage: payload.order.timing_message_snapshot || "",
        kitchenTimingLabel: payload.order.kitchen_timing_label_snapshot || "",
        scheduledFor: payload.order.scheduled_for,
        promotions: (payload.promotions || []).map((row) => ({
          label: row.label,
          discountCents: Number(row.discount_cents),
        })),
        orderItemIds: (payload.orderItems || []).map((row) => row.id),
        loyalty: [],
        reopened: Boolean(reopenedDraft),
      };
      setSavedDraft(draft);
      if (reopenedDraft) {
        setCart([]);
        setCartNotice(
          `Addition saved to order #${draft.displayNumber}. Send it when ready.`,
        );
      }
      if (business === "Tiki" && serviceType === "bar") {
        setActiveTab(draft);
        setActiveTabItems(
          cart.map((line) => ({
            id: line.id,
            item_name_snapshot: line.name,
            variant_name_snapshot: line.variantName,
            quantity: line.quantity,
            line_total_cents: line.unitPriceCents * line.quantity,
          })),
        );
        setCart([]);
      }
      const promotionDiscount = draft.promotions.reduce(
        (sum, row) => sum + row.discountCents,
        0,
      );
      if (
        Number(payload.order.total_cents) !==
        subtotalCents - promotionDiscount + draft.deliveryFeeCents
      ) {
        setCheckoutError(
          `Menu pricing changed. Backend total is ${money(Number(payload.order.total_cents))}; review before continuing.`,
        );
      }
      return draft;
    } catch (error) {
      setCheckoutError(
        error instanceof Error ? error.message : "Could not save draft order.",
      );
      return null;
    } finally {
      setSavingDraft(false);
    }
  }

  async function redeemLoyalty(programId: string, cartLineId: string) {
    if (redeeming) return;
    setRedeeming(true);
    setCheckoutError("");
    try {
      let draft = savedDraft;
      if (!draft) draft = await saveDraft();
      if (!draft) throw new Error("Save the order before applying loyalty.");
      const index = cart.findIndex((line) => line.id === cartLineId),
        orderItemId = draft.orderItemIds[index];
      if (index < 0 || !orderItemId)
        throw new Error("The selected item changed. Review the order.");
      const response = await fetch("/api/ordering/loyalty/redeem", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ orderId: draft.id, orderItemId, programId }),
        }),
        body = await response.json();
      if (!response.ok)
        throw new Error(body.error || "Reward could not be applied.");
      setSavedDraft({
        ...draft,
        totalCents: Number(body.order.total_cents),
        promotions: (body.promotions || []).map(
          (row: { label: string; discount_cents: number }) => ({
            label: row.label,
            discountCents: Number(row.discount_cents),
          }),
        ),
        loyalty: (body.applications || []).map(
          (row: { label: string; discount_cents: number }) => ({
            label: row.label,
            discountCents: Number(row.discount_cents),
          }),
        ),
      });
    } catch (error) {
      setCheckoutError(
        error instanceof Error ? error.message : "Reward could not be applied.",
      );
    } finally {
      setRedeeming(false);
    }
  }

  async function submitOrder(
    draft: SavedDraft | null = savedDraft,
    managerOverride = false,
  ) {
    if (submittingOrder) return;
    if (business === "Corner Deli" && !customer && !savedDraft?.reopened) {
      setCheckoutError(
        "Add the customer's name and phone number before sending this order.",
      );
      setCustomerOpen(true);
      return;
    }
    if (
      business === "Corner Deli" &&
      !selectedCustomerPhoneId &&
      !savedDraft?.reopened
    ) {
      setCheckoutError("Choose a phone number before sending this order.");
      setCustomerOpen(true);
      return;
    }
    if (
      business === "Corner Deli" &&
      serviceType === "delivery" &&
      !validatedAddress &&
      !savedDraft?.reopened
    ) {
      setCheckoutError(
        "Enter and validate the delivery address before sending this order.",
      );
      setDeliveryEditorOpen(true);
      return;
    }
    if (
      business === "Corner Deli" &&
      serviceType === "delivery" &&
      selectedDeliveryLocationId &&
      !deliveryUnit
    ) {
      setCheckoutError(
        "Choose the exact drop-off location before sending this order.",
      );
      return;
    }
    if (business === "Tiki" && activeTab && cart.length)
      draft = await saveDraft();
    if (!draft) draft = activeTab || (await saveDraft());
    if (!draft) return;
    setSubmittingOrder(true);
    setCheckoutError("");
    try {
      const response = await fetch(
        `/api/ordering/orders/${encodeURIComponent(draft.id)}/submit`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            business,
            managerOverride,
            overrideReason: managerOverride ? overrideReason : undefined,
          }),
        },
      );
      const payload = (await response.json()) as {
        order?: { display_number: string; total_cents: number };
        error?: string;
      };
      if (!response.ok || !payload.order)
        throw new Error(payload.error || "Could not submit order.");
      setSubmittedOrder({
        displayNumber: payload.order.display_number,
        totalCents: Number(payload.order.total_cents),
      });
      setCart([]);
      localStorage.removeItem("corner-ops-reopened-order");
      setSavedDraft(null);
      setReopenedItems([]);
      setReopenedCancelItem(null);
      setActiveTab(null);
      setActiveTabItems([]);
      setTabName("");
      setScheduledFor("");
      setTimingMode("asap");
      setOverrideReason("");
      setCustomer(null);
      setSelectedCustomerPhoneId("");
      setSelectedCustomerAddressId("");
      setDeliveryAddress("");
      setDeliveryUnit("");
      setSelectedDeliveryLocationId("");
      setValidatedAddress(null);
      setDeliveryValidationToken("");
      setDeliveryValidatedInput("");
      setDeliveryRoute(null);
    } catch (error) {
      setCheckoutError(
        error instanceof Error ? error.message : "Could not submit order.",
      );
    } finally {
      setSubmittingOrder(false);
    }
  }

  async function openCheckout(draftOverride?: SavedDraft) {
    setLastChangeDueCents(null);
    if (sendRequirement) {
      setCheckoutError(sendRequirement);
      return;
    }
    const draft =
      draftOverride ||
      (business === "Tiki" && activeTab && cart.length
        ? await saveDraft()
        : savedDraft || activeTab || (await saveDraft()));
    if (!draft) return;
    const checksResponse = await fetch(
      `/api/ordering/orders/${encodeURIComponent(draft.id)}/checks`,
    );
    const checksPayload = (await checksResponse.json()) as {
      checks?: PayableCheck[];
      error?: string;
    };
    if (!checksResponse.ok || !checksPayload.checks?.length) {
      setCheckoutError(checksPayload.error || "Could not prepare checks.");
      return;
    }
    const checkId = draft.checkId && checksPayload.checks.some(check=>check.id===draft.checkId) ? draft.checkId : checksPayload.checks[0].id;
    const response = await fetch(
      `/api/ordering/orders/${encodeURIComponent(draft.id)}/payments?business=${encodeURIComponent(business)}&checkId=${encodeURIComponent(checkId)}`,
    );
    const payload = (await response.json()) as CheckoutState & {
      error?: string;
    };
    if (!response.ok) {
      setCheckoutError(payload.error || "Could not open checkout.");
      return;
    }
    setPayableChecks(checksPayload.checks);
    setSelectedCheckId(checkId);
    setCheckoutState(payload);
    setCashTender((Number(payload.check?.amount_due_cents ?? payload.order.amount_due_cents) / 100).toFixed(2));
    setCheckoutOpen(true);
  }

  function closeCheckout() {
    setCheckoutOpen(false);
    if (!savedDraft?.checkoutOnly) return;
    setCheckoutState(null);
    setPayableChecks([]);
    setSelectedCheckId(null);
    setSavedDraft(null);
    window.location.assign(savedDraft?.paymentQueue ? "/pos/deli/payments" : "/pos/deli/orders");
  }

  async function selectCheck(checkId: string) {
    const draft = savedDraft || activeTab;
    if (!draft) return;
    const response = await fetch(
      `/api/ordering/orders/${encodeURIComponent(draft.id)}/payments?business=${encodeURIComponent(business)}&checkId=${encodeURIComponent(checkId)}`,
    );
    const payload = (await response.json()) as CheckoutState & {
      error?: string;
    };
    if (!response.ok) {
      setCheckoutError(payload.error || "Could not load check.");
      return;
    }
    setSelectedCheckId(checkId);
    setCheckoutState(payload);
    setCashTender((Number(payload.check?.amount_due_cents ?? payload.order.amount_due_cents) / 100).toFixed(2));
  }

  async function splitOne(checkId: string, orderItemId: string) {
    const draft = savedDraft || activeTab;
    if (!draft || paymentBusy) return;
    setPaymentBusy(true);
    setCheckoutError("");
    try {
      const response = await fetch(
        `/api/ordering/orders/${encodeURIComponent(draft.id)}/checks`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            fromCheckId: checkId,
            lines: [{ orderItemId, quantity: 1 }],
          }),
        },
      );
      const payload = (await response.json()) as {
        checks?: PayableCheck[];
        newCheckId?: string;
        error?: string;
      };
      if (!response.ok || !payload.checks)
        throw new Error(payload.error || "Could not split check.");
      setPayableChecks(payload.checks);
      await selectCheck(payload.newCheckId || payload.checks[0].id);
    } catch (error) {
      setCheckoutError(
        error instanceof Error ? error.message : "Could not split check.",
      );
    } finally {
      setPaymentBusy(false);
    }
  }

  const checkoutDueCents = Number(
    checkoutState?.check?.amount_due_cents ??
      checkoutState?.order.amount_due_cents ??
      0,
  );

  function cashNumpad(key: string) {
    setCashTender((current) => {
      if (key === "clear") return "";
      if (key === "backspace") return current.slice(0, -1);
      if (key === ".")
        return current.includes(".") ? current : `${current || "0"}.`;
      const decimals = current.split(".")[1];
      if (decimals?.length >= 2) return current;
      if (current === "0" && key !== ".") return key;
      return `${current}${key}`;
    });
  }

  function setQuickCash(amountCents: number) {
    setCashTender((amountCents / 100).toFixed(2));
  }

  async function commitPayment(tenderType: "cash" | "card" | "gift_card") {
    const draft = savedDraft || activeTab;
    if (!draft || !checkoutState || paymentBusy) return;
    const due = Number(
      checkoutState.check?.amount_due_cents ??
        checkoutState.order.amount_due_cents,
    );
    const enteredCents = Math.round(Number(cashTender) * 100);
    const amountTenderedCents = tenderType === "cash" ? enteredCents : Math.min(due, enteredCents);
    if (
      !Number.isSafeInteger(amountTenderedCents) ||
      amountTenderedCents <= 0
    ) {
      setCheckoutError("Enter a valid tender amount.");
      return;
    }
    if (
      tenderType === "gift_card" &&
      !validGiftCardInput(giftCardNumber)
    ) {
      setCheckoutError("Enter a valid gift card number.");
      return;
    }
    setPaymentBusy(true);
    setCheckoutError("");
    try {
      const response = await fetch(
        `/api/ordering/orders/${encodeURIComponent(draft.id)}/payments`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            business,
            checkId: selectedCheckId,
            tenderType,
            amountTenderedCents,
            giftCardNumber: giftCardNumberFromInput(giftCardNumber),
            clientMutationId: clientId(),
            receiptPrinterId: receiptPrinterId || undefined,
            stationKey: stationProfile?.station_key || "",
          }),
        },
      );
      const payload = (await response.json()) as CheckoutState & {
        error?: string;
      };
      if (!response.ok)
        throw new Error(payload.error || "Payment could not be committed.");
      setCheckoutState(payload);
      if (tenderType === "cash") {
        const latest = [...payload.tenders]
          .reverse()
          .find(
            (tender) =>
              tender.transaction_type === "payment" &&
              tender.tender_type === "cash",
          );
        setLastChangeDueCents(Number(latest?.change_due_cents || 0));
      }
      setCashTender("");
      if (tenderType === "gift_card") {
        setGiftCardNumber("");
      }
      setPayableChecks((checks) =>
        checks.map((check) =>
          check.id === selectedCheckId && payload.check
            ? { ...check, ...payload.check }
            : check,
        ),
      );
    } catch (error) {
      setCheckoutError(
        error instanceof Error
          ? error.message
          : "Payment could not be committed.",
      );
    } finally {
      setPaymentBusy(false);
    }
  }

  async function commitTestCard() {
    const draft = savedDraft || activeTab;
    if (!draft || !checkoutState || paymentBusy) return;
    const due = Number(checkoutState.check?.amount_due_cents ?? checkoutState.order.amount_due_cents);
    const amountTenderedCents = cashTender ? Math.round(Number(cashTender) * 100) : due;
    if (!Number.isSafeInteger(amountTenderedCents) || amountTenderedCents <= 0 || amountTenderedCents > due) {
      setCheckoutError("Enter a valid test-card amount no greater than the balance due.");
      return;
    }
    setPaymentBusy(true);
    setCheckoutError("");
    try {
      const response = await fetch(`/api/ordering/orders/${encodeURIComponent(draft.id)}/payments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ business, checkId: selectedCheckId, tenderType: "card", testCard: true, amountTenderedCents, clientMutationId: clientId(), receiptPrinterId: receiptPrinterId || undefined, stationKey: stationProfile?.station_key || "" }),
      });
      const payload = await response.json() as CheckoutState & { error?: string };
      if (!response.ok) throw new Error(payload.error || "Test card could not be committed.");
      setCheckoutState(payload);
      setCashTender((Number(payload.check?.amount_due_cents ?? payload.order.amount_due_cents) / 100).toFixed(2));
    } catch (error) {
      setCheckoutError(error instanceof Error ? error.message : "Test card could not be committed.");
    } finally {
      setPaymentBusy(false);
    }
  }

  async function sendToPaymentStation(){
    const draft=savedDraft||activeTab;if(!draft||paymentBusy)return;setPaymentBusy(true);setCheckoutError("");
    try{const response=await fetch("/api/ordering/payment-stations",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"queue",orderId:draft.id,checkId:selectedCheckId,stationKey:stationProfile?.station_key||"",note:`Order #${draft.displayNumber}`})}),body=await response.json();if(!response.ok)throw new Error(body.error||"Could not send this check to the payment station.");setCheckoutError(body.duplicate?"This check is already waiting at the payment station.":"Sent to the payment station.")}
    catch(error){setCheckoutError(error instanceof Error?error.message:"Could not send this check to the payment station.")}finally{setPaymentBusy(false)}
  }

  async function startHelcimPayment(requestedOverride?: number, stateOverride?: CheckoutState) {
    const draft = savedDraft || activeTab;
    const activeCheckout = stateOverride || checkoutState;
    if (!draft || !activeCheckout || paymentBusy) return;
    setPaymentBusy(true);
    setHelcimOpen(true);
    setCheckoutError("");
    try {
      const due = Number(activeCheckout.check?.amount_due_cents ?? activeCheckout.order.amount_due_cents);
      const requestedCents = requestedOverride ?? (cashTender.trim() ? Math.round(Number(cashTender) * 100) : due);
      if (!Number.isSafeInteger(requestedCents) || requestedCents <= 0 || requestedCents > due)
        throw new Error("Enter a card amount between $0.01 and the remaining balance.");
      if (!window.appendHelcimPayIframe) {
        await new Promise<void>((resolve, reject) => {
          const existing = document.querySelector<HTMLScriptElement>(
            'script[data-helcim-pay="true"]',
          );
          if (existing) {
            existing.addEventListener("load", () => resolve(), { once: true });
            existing.addEventListener(
              "error",
              () => reject(new Error("Could not load Helcim checkout.")),
              { once: true },
            );
            return;
          }
          const script = document.createElement("script");
          script.src = "https://secure.helcim.app/helcim-pay/services/start.js";
          script.async = true;
          script.dataset.helcimPay = "true";
          script.onload = () => resolve();
          script.onerror = () =>
            reject(new Error("Could not load Helcim checkout."));
          document.head.appendChild(script);
        });
      }
      const response = await fetch(
        `/api/ordering/orders/${encodeURIComponent(draft.id)}/payments/helcim`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "initialize",
            checkId: selectedCheckId,
            amountCents: requestedCents,
          }),
        },
      );
      const initialized = (await response.json()) as {
        checkoutToken?: string;
        secretToken?: string;
        error?: string;
      };
      if (
        !response.ok ||
        !initialized.checkoutToken ||
        !initialized.secretToken
      )
        throw new Error(
          initialized.error || "Could not start Helcim checkout.",
        );
      const checkoutToken = initialized.checkoutToken;
      const secretToken = initialized.secretToken;
      const eventName = `helcim-pay-js-${checkoutToken}`;
      const result = await new Promise<CheckoutState>((resolve, reject) => {
        const listener = async (event: MessageEvent) => {
          if (
            event.origin !== "https://secure.helcim.app" ||
            event.data?.eventName !== eventName
          )
            return;
          if (event.data.eventStatus === "HIDE") {
            window.removeEventListener("message", listener);
            reject(new Error("Helcim checkout was closed."));
            return;
          }
          if (event.data.eventStatus === "ABORTED") {
            window.removeEventListener("message", listener);
            reject(
              new Error(
                typeof event.data.eventMessage === "string"
                  ? event.data.eventMessage
                  : "Helcim declined the payment.",
              ),
            );
            return;
          }
          if (event.data.eventStatus !== "SUCCESS") return;
          window.removeEventListener("message", listener);
          try {
            const message = unwrapHelcimPayResponse(event.data.eventMessage);
            const confirmation = await fetch(
              `/api/ordering/orders/${encodeURIComponent(draft.id)}/payments/helcim`,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  action: "confirm",
                  checkoutToken,
                  secretToken,
                  data: message.data,
                  hash: message.hash,
                }),
              },
            );
            const payload = (await confirmation.json()) as CheckoutState & {
              error?: string;
            };
            if (!confirmation.ok)
              throw new Error(
                payload.error || "Helcim payment could not be verified.",
              );
            resolve(payload);
          } catch (error) {
            reject(error);
          }
        };
        window.addEventListener("message", listener);
        if (!window.appendHelcimPayIframe) {
          window.removeEventListener("message", listener);
          reject(new Error("Helcim checkout did not load."));
          return;
        }
        window.appendHelcimPayIframe(checkoutToken);
      });
      setCheckoutState(result);
      setCashTender((Number(result.check?.amount_due_cents ?? result.order.amount_due_cents) / 100).toFixed(2));
      setPayableChecks((checks) =>
        checks.map((check) =>
          check.id === selectedCheckId && result.check
            ? { ...check, ...result.check }
            : check,
        ),
      );
    } catch (error) {
      setCheckoutError(
        error instanceof Error ? error.message : "Helcim payment failed.",
      );
    } finally {
      window.removeHelcimPayIframe?.();
      setHelcimOpen(false);
      setPaymentBusy(false);
    }
  }

  async function applyTipAndStartCard(tipCents: number) {
    const draft = savedDraft || activeTab;
    if (!draft || paymentBusy) return;
    setTipPromptOpen(false);
    const enteredCents = Math.round(Number(cashTender) * 100);
    setPaymentBusy(true);
    setCheckoutError("");
    try {
      const response = await fetch(`/api/ordering/orders/${encodeURIComponent(draft.id)}/payments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ business, action: "set_tip", checkId: selectedCheckId, tipCents }),
      });
      const payload = await response.json() as CheckoutState & { error?: string };
      if (!response.ok) throw new Error(payload.error || "Tip could not be added.");
      setCheckoutState(payload);
      const due = Number(payload.check?.amount_due_cents ?? payload.order.amount_due_cents);
      const cardAmount = Math.min(due, enteredCents + tipCents);
      setCashTender((cardAmount / 100).toFixed(2));
      setPaymentBusy(false);
      setCustomTip("");
      window.setTimeout(() => void startHelcimPayment(cardAmount, payload), 0);
    } catch (error) {
      setCheckoutError(error instanceof Error ? error.message : "Tip could not be added.");
      setPaymentBusy(false);
      return;
    }
  }

  function chooseCredit() {
    const enteredCents = Math.round(Number(cashTender) * 100);
    if (!Number.isSafeInteger(enteredCents) || enteredCents <= 0 || enteredCents > checkoutDueCents) {
      setCheckoutError("Enter a credit amount between $0.01 and the remaining balance.");
      return;
    }
    if (stationProfile?.payment_terminal_id) {
      void startHelcimPayment();
      return;
    }
    setTipPromptOpen(true);
  }

  async function paymentOperation(
    action: "reverse" | "reprint",
    transactionId: string,
    maximumCents: number,
  ) {
    const draft = savedDraft || activeTab;
    if (!draft || paymentBusy) return;
    const reason = window
      .prompt(
        action === "reverse"
          ? "Manager reversal reason"
          : "Receipt reprint reason",
        "",
      )
      ?.trim();
    if (!reason) return;
    let amountCents = maximumCents;
    if (action === "reverse") {
      const entered = window.prompt(
        `Amount to reverse (maximum ${money(maximumCents)})`,
        (maximumCents / 100).toFixed(2),
      );
      if (entered === null) return;
      amountCents = Math.round(Number(entered) * 100);
      if (
        !Number.isSafeInteger(amountCents) ||
        amountCents <= 0 ||
        amountCents > maximumCents
      ) {
        setCheckoutError(
          "Enter a valid reversal amount within the unreversed tender balance.",
        );
        return;
      }
    }
    setPaymentBusy(true);
    setCheckoutError("");
    try {
      const response = await fetch(
        `/api/ordering/orders/${encodeURIComponent(draft.id)}/payments`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action,
            business,
            transactionId,
            amountCents,
            reason,
            clientMutationId: clientId(),
          }),
        },
      );
      const payload = (await response.json()) as CheckoutState & {
        error?: string;
      };
      if (!response.ok)
        throw new Error(payload.error || "Payment operation failed.");
      if (action === "reverse") {
        setCheckoutState(payload);
        const checksResponse = await fetch(
          `/api/ordering/orders/${encodeURIComponent(draft.id)}/checks`,
        );
        if (checksResponse.ok) {
          const checksPayload = (await checksResponse.json()) as {
            checks?: PayableCheck[];
          };
          if (checksPayload.checks) setPayableChecks(checksPayload.checks);
        }
      }
    } catch (error) {
      setCheckoutError(
        error instanceof Error ? error.message : "Payment operation failed.",
      );
    } finally {
      setPaymentBusy(false);
    }
  }

  if (!session)
    return <main className="posLoading">Loading {business} POS…</main>;
  if (!session.authenticated && business === "Corner Deli")
    return (
      <PosPinGate
        onAuthenticated={(employee) =>
          setSession({ authenticated: true, session: employee })
        }
      />
    );
  if (!session.authenticated)
    return (
      <main className="posLoading">
        <a href="/signin">Sign in to Corner Ops</a>
      </main>
    );
  if (
    "businesses" in session &&
    session.businesses?.length &&
    !session.businesses.includes(business)
  ) {
    return (
      <main className="posLoading">
        Your account does not have access to {business}.
      </main>
    );
  }
  const posEmployee =
    "session" in session
      ? (session.session as PosEmployeeSession | undefined)
      : undefined;
  const canManageBarcodes = posEmployee
    ? posEmployee.posRole !== "employee"
    : "role" in session &&
      (session.role === "Owner" ||
        session.role === "Co-Owner" ||
        session.role === "Manager");
  const canManagePayments = canManageBarcodes;
  const selectedDeliveryLocation = DELIVERY_LOCATIONS.find(
    (location) => location.id === selectedDeliveryLocationId,
  );
  const sendRequirement =
    business === "Corner Deli" && !customer
      ? "Customer name and phone required"
      : business === "Corner Deli" && !selectedCustomerPhoneId
        ? "Choose customer phone"
        : business === "Corner Deli" &&
            serviceType === "delivery" &&
            !validatedAddress
          ? "Validated delivery address required"
          : business === "Corner Deli" &&
              serviceType === "delivery" &&
              selectedDeliveryLocation &&
              !deliveryUnit
            ? "Choose exact drop-off location"
            : "";
  const deliveryAddressRequired =
    business === "Corner Deli" &&
    serviceType === "delivery" &&
    Boolean(customer) &&
    !validatedAddress;
  async function showTabs() {
    setTabsOpen(true);
    setTabsLoading(true);
    setCheckoutError("");
    try {
      const response = await fetch("/api/ordering/tiki-tabs", {
          cache: "no-store",
        }),
        payload = await response.json();
      if (!response.ok)
        throw new Error(payload.error || "Could not load tabs.");
      setOpenTabs(payload.tabs || []);
    } catch (error) {
      setCheckoutError(
        error instanceof Error ? error.message : "Could not load tabs.",
      );
    } finally {
      setTabsLoading(false);
    }
  }
  async function chooseTab(tab: OpenTikiTab) {
    const response = await fetch(
        `/api/ordering/tiki-tabs/${encodeURIComponent(tab.id)}`,
        { cache: "no-store" },
      ),
      payload = await response.json();
    if (!response.ok) {
      setCheckoutError(payload.error || "Could not open tab.");
      return;
    }
    const detail = payload.tab;
    const draft: SavedDraft = {
      id: detail.id,
      displayNumber: detail.display_number,
      totalCents: Number(detail.total_cents),
      deliveryFeeCents: 0,
      timingMessage: "Open bar tab",
      kitchenTimingLabel: "BAR",
      scheduledFor: null,
      promotions: [],
      orderItemIds: (detail.items || []).map((item: any) => item.id),
      loyalty: [],
    };
    setServiceType("bar");
    setActiveTab(draft);
    setSavedDraft(draft);
    setActiveTabItems(detail.items || []);
    setTabName(detail.first_name_snapshot || "");
    setCart([]);
    setTabsOpen(false);
  }

  return (
    <main className={`posPage ${embedded ? "posPageEmbedded" : ""}`}>
      {!embedded && (
        <header className="posHeader posHeaderFixedBusiness">
          <div className="posBrandBlock">
            <span className="posDevBadge">DEVELOPMENT · AUTO DEPLOY OFF</span>
            <strong>{business} POS</strong>
            <small className="posSeparateNote">
              Separate development POS · not connected to the live application
            </small>
          </div>
          <nav
            className="posUtilityNav"
            aria-label={`${business} POS utilities`}
          >
            {posEmployee && (
              <span className="posEmployeeName">{posEmployee.name}</span>
            )}
            {config.utilities.map((utility) =>
              business === "Corner Deli" && utility === "orders" ? (
                <a key={utility} href="/pos/deli/orders">
                  Orders
                </a>
              ) : business === "Corner Deli" && utility === "manager" ? (
                <a key={utility} href="/pos/deli/settings">
                  Settings
                </a>
              ) : business === "Corner Deli" && utility === "drivers" ? (
                <a key={utility} href="/pos/deli/drivers">
                  Drivers
                </a>
              ) : utility === "bar_tabs" ? (
                <button
                  key={utility}
                  type="button"
                  onClick={() => void showTabs()}
                >
                  Bar Tabs
                </button>
              ) : utility === "reports" ? (
                <a key={utility} href={config.reportsPath}>
                  {utilityLabels[utility]}
                </a>
              ) : (
                <button key={utility} type="button">
                  {utilityLabels[utility]}
                </button>
              ),
            )}
            {business === "Corner Deli" && (
              <a href="/pos/deli/kitchen">Kitchen</a>
            )}
            {business === "Corner Deli" && (
              <button type="button" onClick={() => lockPos()}>
                LOCK / SWITCH EMPLOYEE
              </button>
            )}
            <a href="/pos">POS Dev Home</a>
          </nav>
        </header>
      )}

      <section
        className="posServiceBar"
        aria-label="Fulfillment type and timing"
      >
        {availableServices.map((service) => (
          <button
            key={service}
            type="button"
            className={serviceType === service ? "active" : ""}
            onClick={() => {
              setServiceType(service);
              setSavedDraft(null);
              setDeliveryEditorOpen(false);
              if (service !== "bar") {
                setActiveTab(null);
                setActiveTabItems([]);
              }
              setCheckoutError("");
            }}
          >
            <span>{serviceLabels[service].label}</span>
            {serviceLabels[service].paymentNote && (
              <small>{serviceLabels[service].paymentNote}</small>
            )}
          </button>
        ))}
        {business === "Corner Deli" && (
          <>
            <button
              type="button"
              className={`futureOrderButton ${timingMode === "asap" ? "active" : ""}`}
              onClick={() => {
                setTimingMode("asap");
                setSavedDraft(null);
              }}
            >
              <span>ASAP</span>
              <small>Use current quote</small>
            </button>
            <button
              type="button"
              className={`futureOrderButton ${timingMode === "future" ? "active" : ""}`}
              onClick={() => {
                setTimingMode("future");
                setFutureDate(deliBusinessDate());
                setScheduledFor("");
                setSavedDraft(null);
              }}
            >
              <span>Future</span>
              <small>Choose time</small>
            </button>
            {timingMode === "future" && (
              <div className="posFuturePicker">
                <input
                  className="posFutureTimeInput"
                  aria-label="Future order date"
                  type="date"
                  min={deliBusinessDate()}
                  value={futureDate}
                  onChange={(event) => {
                    setFutureDate(event.target.value);
                    setScheduledFor("");
                    setSavedDraft(null);
                  }}
                />
                <select
                  aria-label="Future order time"
                  value={scheduledFor}
                  disabled={futureSlotsLoading || !futureSlots.length}
                  onChange={(event) => {
                    setScheduledFor(event.target.value);
                    setSavedDraft(null);
                  }}
                >
                  <option value="">
                    {futureSlotsLoading
                      ? "Loading times…"
                      : futureSlots.length
                        ? "Choose time"
                        : "No valid times"}
                  </option>
                  {futureSlots.map((slot) => (
                    <option key={slot} value={slot}>
                      {new Intl.DateTimeFormat("en-US", {
                        timeZone: "America/New_York",
                        hour: "numeric",
                        minute: "2-digit",
                      }).format(new Date(slot))}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </>
        )}
        {business === "Tiki" && serviceType === "bar" && !activeTab && (
          <label className="posTabName">
            TAB NAME{" "}
            <input
              value={tabName}
              maxLength={80}
              placeholder="Guest name or seat (optional)"
              onChange={(event) => setTabName(event.target.value)}
            />
          </label>
        )}
        <div
          className={`posCustomerDeliveryArea ${serviceType === "delivery" ? "hasDelivery" : ""}`}
        >
          <button
            type="button"
            className="posCustomerCompact"
            onClick={() => setCustomerOpen(true)}
          >
            {customer ? (
              <>
                <strong>{customer.display_name}</strong>
                <span>
                  {customer.phones?.find(
                    (phone) => phone.id === selectedCustomerPhoneId,
                  )?.display_phone || customer.display_phone}
                </span>
                {loyalty.map((program) => (
                  <small key={program.programId}>
                    {program.name}:{" "}
                    {program.rewardsAvailable
                      ? `${program.rewardsAvailable} FREE REWARD${program.rewardsAvailable === 1 ? "" : "S"} AVAILABLE`
                      : `${program.progress} / ${program.quantityRequired}`}
                  </small>
                ))}
              </>
            ) : (
              <>
                <strong>+ CUSTOMER</strong>
                <span>
                  {business === "Tiki" ? "Optional" : "Name and phone required"}
                </span>
              </>
            )}
          </button>
          {customer &&
            loyalty.some((program) => program.rewardsAvailable > 0) &&
            cart.length > 0 && (
              <div
                className="posCustomerChoices"
                aria-label="Available loyalty rewards"
              >
                {loyalty
                  .filter((program) => program.rewardsAvailable > 0)
                  .map((program) => (
                    <div key={program.programId}>
                      <strong>{program.name}</strong>
                      {cart.map((line) => (
                        <button
                          disabled={
                            redeeming || Boolean(savedDraft?.loyalty.length)
                          }
                          key={line.id}
                          onClick={() =>
                            void redeemLoyalty(program.programId, line.id)
                          }
                        >
                          REDEEM ON {line.name}
                        </button>
                      ))}
                    </div>
                  ))}
              </div>
            )}
          {customer && customer.phones?.length > 1 && (
            <div
              className="posCustomerChoices"
              aria-label="Contact number for this order"
            >
              <strong>CONTACT NUMBER</strong>
              {customer.phones.map((phone) => (
                <button
                  type="button"
                  key={phone.id}
                  className={
                    selectedCustomerPhoneId === phone.id ? "selected" : ""
                  }
                  onClick={() => {
                    setSelectedCustomerPhoneId(phone.id);
                    setSavedDraft(null);
                  }}
                >
                  {phone.label || "Phone"} · {phone.display_phone}
                </button>
              ))}
            </div>
          )}

          {serviceType === "delivery" && (
            <section
              className="posDelivery"
              aria-label="Customer and delivery address"
            >
              <div className="posDeliveryEditor">
                <div className="posAddressEntry">
                  <div className="posAddressAutocomplete">
                    <input
                      className={deliveryAddressRequired ? "posDeliveryAddressRequired" : undefined}
                      value={deliveryAddress}
                      autoComplete="off"
                      spellCheck={false}
                      aria-label="Delivery street address"
                      aria-invalid={deliveryAddressRequired}
                      placeholder="Type delivery address"
                      aria-expanded={addressSuggestions.length > 0}
                      aria-controls="delivery-address-suggestions"
                      onChange={(event) =>
                        changeDeliveryAddress(event.target.value)
                      }
                      onKeyDown={(event) => {
                        if (event.key === "ArrowDown") {
                          event.preventDefault();
                          setActiveSuggestion((current) =>
                            Math.min(
                              addressSuggestions.length - 1,
                              current + 1,
                            ),
                          );
                        }
                        if (event.key === "ArrowUp") {
                          event.preventDefault();
                          setActiveSuggestion((current) =>
                            Math.max(0, current - 1),
                          );
                        }
                        if (event.key === "Escape") setAddressSuggestions([]);
                        if (event.key === "Enter") {
                          event.preventDefault();
                          const suggestion =
                            addressSuggestions[activeSuggestion];
                          if (suggestion) void validateAddress(suggestion);
                          else void validateAddress();
                        }
                      }}
                    />
                    {(addressLoading ||
                      addressSuggestions.length > 0 ||
                      (deliveryAddress.trim().length >= 2 &&
                        !addressLoading &&
                        !validatedAddress &&
                        !addressError)) && (
                      <div
                        id="delivery-address-suggestions"
                        className="posAddressSuggestions"
                        role="listbox"
                      >
                        {addressLoading && (
                          <div className="addressState">
                            Finding nearby addresses…
                          </div>
                        )}
                        {!addressLoading &&
                          addressSuggestions.map((suggestion, index) => (
                            <button
                              key={suggestion.id}
                              type="button"
                              role="option"
                              aria-selected={activeSuggestion === index}
                              className={
                                activeSuggestion === index ? "active" : ""
                              }
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={() => void validateAddress(suggestion)}
                            >
                              <strong>{suggestion.mainText}</strong>
                              <span>{suggestion.secondaryText}</span>
                            </button>
                          ))}
                        {!addressLoading && !addressSuggestions.length && (
                          <div className="addressState">
                            No addresses found.
                          </div>
                        )}
                        {addressSuggestions.some(
                          (suggestion) => suggestion.provider === "google",
                        ) && <small>Address results powered by Google</small>}
                      </div>
                    )}
                  </div>
                  {!selectedDeliveryLocation && (
                    <input
                      className="posDeliveryUnit"
                      aria-label="Apartment or unit"
                      placeholder="Apt / unit"
                      value={deliveryUnit}
                      maxLength={120}
                      autoComplete="off"
                      onChange={(event) => {
                        setDeliveryUnit(event.target.value);
                        setSavedDraft(null);
                      }}
                    />
                  )}
                  <button
                    type="button"
                    className="validateAddressButton"
                    disabled={
                      validatingAddress ||
                      deliveryAddress.trim().length < 5 ||
                      Boolean(validatedAddress)
                    }
                    onClick={() => void validateAddress()}
                  >
                    {validatingAddress
                      ? "Validating…"
                      : validatedAddress
                        ? "✓ Validated"
                        : "Validate"}
                  </button>
                </div>
                {selectedDeliveryLocation && (
                  <div
                    className="posDeliveryDropoffs"
                    aria-label={`${selectedDeliveryLocation.name} drop-off location`}
                  >
                    <strong>
                      WHERE AT {selectedDeliveryLocation.name.toUpperCase()}?
                    </strong>
                    {selectedDeliveryLocation.dropoffs.map((dropoff) => (
                      <button
                        type="button"
                        key={dropoff}
                        className={deliveryUnit === dropoff ? "selected" : ""}
                        onClick={() => {
                          setDeliveryUnit(dropoff);
                          setSavedDraft(null);
                          setCheckoutError("");
                        }}
                      >
                        {dropoff}
                      </button>
                    ))}
                  </div>
                )}
                {customer?.addresses?.length ? (
                  <div
                    className="posSavedAddresses"
                    aria-label="Saved delivery addresses"
                  >
                    <strong>DELIVER TO</strong>
                    {customer.addresses.map((address) => (
                      <button
                        type="button"
                        key={address.id}
                        className={
                          selectedCustomerAddressId === address.id
                            ? "selected"
                            : ""
                        }
                        onClick={() => void chooseSavedAddress(address)}
                      >
                        <b>{address.label || "Address"}</b>
                        <span>
                          {address.line1}
                          {address.line2 ? ` · ${address.line2}` : ""}
                        </span>
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedCustomerAddressId("");
                        changeDeliveryAddress("");
                      }}
                    >
                      + NEW ADDRESS
                    </button>
                  </div>
                ) : null}
                {validatedAddress && (
                  <p className="addressResult">
                    <strong>{validatedAddress.formattedAddress}</strong>
                    {deliveryRoute
                      ? ` · ${deliveryRoute.distanceMiles.toFixed(1)} driving miles · about ${Math.max(1, Math.round(deliveryRoute.durationSeconds / 60))} min`
                      : " · Driving distance unavailable until store origin is configured"}
                  </p>
                )}
                {addressError && (
                  <p className="addressError" role="alert">
                    {addressError}
                  </p>
                )}
              </div>
            </section>
          )}
        </div>
      </section>

      {(savedDraft || activeTab) && (
        <div className="posSaveNotice">
          {activeTab
            ? `Open tab ${tabName || `#${activeTab.displayNumber}`}`
            : `Held order #${savedDraft!.displayNumber}`}{" "}
          · {money((savedDraft || activeTab)!.totalCents)} · UNPAID
          {(savedDraft || activeTab)!.timingMessage
            ? ` · ${(savedDraft || activeTab)!.timingMessage}`
            : ""}
          {(savedDraft || activeTab)!.kitchenTimingLabel
            ? ` · Kitchen: ${(savedDraft || activeTab)!.kitchenTimingLabel.replace(/\n/g, " / ")}`
            : ""}
        </div>
      )}
      {submittedOrder && (
        <div className="posSaveNotice success" role="status">
          Order #{submittedOrder.displayNumber} submitted to kitchen ·{" "}
          {money(submittedOrder.totalCents)} · UNPAID
        </div>
      )}
      {checkoutError && (
        <div className="posSaveNotice error">{checkoutError}</div>
      )}
      {checkoutError.includes("Manager or owner override") &&
        posEmployee &&
        posEmployee.posRole !== "employee" && (
          <div className="posSettingsWarning">
            <label>
              <span>Manager override reason</span>
              <input
                value={overrideReason}
                onChange={(event) => setOverrideReason(event.target.value)}
              />
            </label>
            <button
              type="button"
              disabled={!overrideReason.trim() || submittingOrder}
              onClick={() => void submitOrder(savedDraft, true)}
            >
              AUTHORIZE SEND OVERRIDE
            </button>
          </div>
        )}
      {cartNotice && (
        <div className="posCartToast" aria-live="polite">
          {cartNotice}
        </div>
      )}

      <section className="posWorkspace">
        <section className="posMenuPanel">
          <nav className="posMenuNavigation" aria-label="Menu categories">
            <div className="posPrimaryCategories">
              {primaryCategories.map((category) => (
                <button
                  type="button"
                  key={category.id}
                  className={
                    activePrimary?.id === category.id && !menuSearch
                      ? "active"
                      : ""
                  }
                  onClick={() => {
                    setMenuSearch("");
                    setPrimaryCategoryId(category.id);
                    const children = menu.filter(
                      (child) => child.parentId === category.id,
                    );
                    setCategoryId(
                      category.presentationOnly
                        ? children[0]?.id || ""
                        : category.id,
                    );
                  }}
                >
                  {category.displayName}
                </button>
              ))}
            </div>
            {subcategories.length > 0 && !menuSearch && (
              <div
                className="posSubcategories"
                aria-label={`${activePrimary?.displayName} subcategories`}
              >
                {subcategories.map((category) => (
                  <button
                    type="button"
                    key={category.id}
                    className={
                      activeCategory?.id === category.id ? "active" : ""
                    }
                    onClick={() => setCategoryId(category.id)}
                  >
                    {category.displayName}
                  </button>
                ))}
              </div>
            )}
          </nav>
          <div className="posPanelHeading">
            <div>
              <span>{menuSearch ? "Search results" : "Category"}</span>
              <h1>
                {menuSearch
                  ? `Results for “${menuSearch}”`
                  : activeCategory?.displayName || "Menu"}
              </h1>
            </div>
            <div className="posStatusPill">
              {serviceLabels[serviceType].label} ·{" "}
              {timingMode === "asap" ? "ASAP" : "Future"}
            </div>
          </div>
          <label className="posMenuSearch">
            Search menu
            <input
              ref={searchInputRef}
              type="search"
              value={menuSearch}
              placeholder="Search items or sizes"
              onChange={(event) => setMenuSearch(event.target.value)}
            />
          </label>
          {scanNotice && (
            <div className="posScanNotice" role="status">
              {scanNotice}
              <button
                type="button"
                aria-label="Dismiss scan message"
                onClick={() => setScanNotice("")}
              >
                ×
              </button>
            </div>
          )}
          {menuLoading && <div className="posEmpty">Loading menu…</div>}
          {menuError && <div className="posEmpty error">{menuError}</div>}
          {!menuLoading && !menuError && !visibleItems.length && (
            <div className="posEmpty">
              {menuSearch
                ? "No matching menu items."
                : "No active items in this category yet."}
            </div>
          )}
          <div className="posItemGrid">
            {visibleItems.map((item) => {
              const availableVariants = item.variants.filter(
                (variant) => variant.available,
              );
              const displayPrice = availableVariants.length
                ? Math.min(
                    ...availableVariants.map(
                      (variant) => variant.basePriceCents,
                    ),
                  )
                : item.basePriceCents;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`posItemButton ${item.available ? "" : "soldOut"}`}
                  disabled={!item.available}
                  onClick={() => selectItem(item)}
                >
                  {item.imageUrl && (
                    <img
                      src={item.imageUrl}
                      alt={item.imageAlt}
                      loading="lazy"
                    />
                  )}
                  <strong>{item.name}</strong>
                  <span>
                    {availableVariants.length > 1
                      ? `From ${money(displayPrice)}`
                      : money(displayPrice)}
                  </span>
                  {!item.available && <small>SOLD OUT</small>}
                </button>
              );
            })}
          </div>
        </section>

        <aside className="posCart">
          <div className="posCartHeading posCartHeadingCompact">
            <strong>ORDER ITEMS</strong>
            <button
              type="button"
              onClick={() => {
                setCart([]);
                invalidateEditableDraft();
              }}
              disabled={!cart.length}
            >
              CLEAR
            </button>
          </div>
          <div className="posCartLines">
            {reopenedItems
              .filter((line) => Number(line.quantity) > Number(line.cancelled_quantity || 0))
              .map((line) => {
                const remaining = Number(line.quantity) - Number(line.cancelled_quantity || 0);
                return (
                  <article
                    className="posCartLine posPersistedTabLine posReopenedLine"
                    key={line.id}
                    onTouchStart={(event) => {
                      const touch = event.touches[0];
                      swipeStart.current = { id: line.id, x: touch.clientX, y: touch.clientY };
                    }}
                    onTouchEnd={(event) => {
                      const start = swipeStart.current, touch = event.changedTouches[0];
                      swipeStart.current = null;
                      if (start?.id === line.id && start.x - touch.clientX > 80 && Math.abs(start.y - touch.clientY) < 45)
                        setReopenedCancelItem(line);
                    }}
                  >
                    <div className="posLineTop">
                      <strong>{remaining}× {line.item_name_snapshot}</strong>
                      <span>{money(Number(line.line_total_cents))}</span>
                    </div>
                    {line.variant_name_snapshot && <small>Size / form: {line.variant_name_snapshot}</small>}
                    {(line.modifiers || []).filter((modifier) => modifier.print_on_ticket !== false).map((modifier) => (
                      <small key={modifier.id}>{modifier.option_name_snapshot || modifier.name_snapshot}</small>
                    ))}
                    {line.special_instructions && <small>Note: {line.special_instructions}</small>}
                    <div className="posReopenedLineFooter">
                      <small>EXISTING ITEM · LOCKED</small>
                      <button type="button" onClick={() => setReopenedCancelItem(line)}>VOID</button>
                    </div>
                  </article>
                );
              })}
            {activeTabItems.map((line) => (
              <article
                className="posCartLine posPersistedTabLine"
                key={line.id}
              >
                <div className="posLineTop">
                  <strong>
                    {line.quantity}× {line.item_name_snapshot}
                  </strong>
                  <span>{money(Number(line.line_total_cents))}</span>
                </div>
                {line.variant_name_snapshot && (
                  <small>{line.variant_name_snapshot}</small>
                )}
                <small>Already on tab</small>
              </article>
            ))}
            {!cart.length && !activeTabItems.length && !reopenedItems.some((line) => Number(line.quantity) > Number(line.cancelled_quantity || 0)) && (
              <div className="posEmpty">
                Tap a menu item to start the order.
              </div>
            )}
            {cart.map((line) => (
              <article
                className="posCartLine"
                key={line.id}
                onTouchStart={(e) => {
                  const t = e.touches[0];
                  swipeStart.current = {
                    id: line.id,
                    x: t.clientX,
                    y: t.clientY,
                  };
                }}
                onTouchEnd={(e) => {
                  const s = swipeStart.current,
                    t = e.changedTouches[0];
                  swipeStart.current = null;
                  if (
                    s?.id === line.id &&
                    s.x - t.clientX > 80 &&
                    Math.abs(s.y - t.clientY) < 45
                  )
                    removeLine(line.id);
                }}
              >
                <div className="posLineTop">
                  <strong>
                    {line.quantity}× {line.name}
                  </strong>
                  <span>{money(line.unitPriceCents * line.quantity)}</span>
                </div>
                {line.variantName && (
                  <small>Size / form: {line.variantName}</small>
                )}
                {[...line.modifierText, ...line.comboText].map(
                  (text, index) => (
                    <small key={`${text}-${index}`}>{text}</small>
                  ),
                )}
                {line.specialInstructions && (
                  <small>Note: {line.specialInstructions}</small>
                )}
                <div className="posQtyControls">
                  <button
                    type="button"
                    onClick={() => changeQuantity(line.id, -1)}
                  >
                    −
                  </button>
                  <span>{line.quantity}</span>
                  <button
                    type="button"
                    onClick={() => changeQuantity(line.id, 1)}
                  >
                    +
                  </button>
                  <button
                    type="button"
                    aria-label={`Edit ${line.name}`}
                    className="posLineAction"
                    onClick={() => {
                      const item = menu
                        .flatMap((category) => category.items)
                        .find((candidate) => candidate.id === line.itemId);
                      if (item) openItem(item, line);
                      else
                        setCheckoutError(
                          "This menu item changed and can no longer be edited.",
                        );
                    }}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove ${line.name}`}
                    className="posLineAction danger"
                    onClick={() => removeLine(line.id)}
                  >
                    Remove
                  </button>
                </div>
              </article>
            ))}
          </div>
          <div className="posTotals">
            <div>
              <span>Subtotal</span>
              <strong>{money(subtotalCents)}</strong>
            </div>
            {visiblePromotions.map((promotion, index) => (
              <div key={`${promotion.label}-${index}`}>
                <span>{promotion.label}</span>
                <strong>−{money(promotion.discountCents)}</strong>
              </div>
            ))}
            {savedDraft?.loyalty.map((reward, index) => (
              <div key={`${reward.label}-${index}`}>
                <span>{reward.label} · Loyalty</span>
                <strong>−{money(reward.discountCents)}</strong>
              </div>
            ))}
            {(savedDraft?.deliveryFeeCents || quotedDeliveryFeeCents) != null &&
              serviceType === "delivery" && (
                <div>
                  <span>
                    Delivery fee
                    {deliveryRoute
                      ? ` · ${deliveryRoute.distanceMiles.toFixed(1)} mi`
                      : ""}
                  </span>
                  <strong>
                    {money(
                      savedDraft?.deliveryFeeCents ??
                        quotedDeliveryFeeCents ??
                        0,
                    )}
                  </strong>
                </div>
              )}
            <div className="grand">
              <span>{savedDraft ? "Backend total" : "Estimated total"}</span>
              <strong>
                {money(
                  savedDraft?.totalCents ??
                    Math.max(
                      0,
                      subtotalCents -
                        promotionDiscountCents +
                        (quotedDeliveryFeeCents || 0),
                    ),
                )}
              </strong>
            </div>
          </div>
          <div className="posCheckoutButtons">
            <button
              type="button"
              disabled={
                !cart.length ||
                savingDraft ||
                Boolean(savedDraft && !activeTab) ||
                (timingMode === "future" && !scheduledFor)
              }
              onClick={() => void saveDraft()}
            >
              {savingDraft
                ? "SAVING…"
                : activeTab
                  ? "ADD TO TAB"
                  : business === "Tiki" && serviceType === "bar"
                    ? "OPEN TAB"
                    : "HOLD"}
            </button>
            {sendRequirement && (
              <p className="posSendRequirement" role="status">
                {sendRequirement}
              </p>
            )}
            <button
              type="button"
              className="submitOrder"
              aria-disabled={Boolean(sendRequirement)}
              disabled={!cart.length || submittingOrder || savingDraft || Boolean(sendRequirement)}
              onClick={() => void submitOrder()}
            >
              {submittingOrder ? "SENDING…" : "SEND"}
            </button>
            <button
              type="button"
              className="primary"
              disabled={(!cart.length && !activeTab) || savingDraft || Boolean(sendRequirement)}
              onClick={() => void openCheckout()}
            >
              CHECKOUT
            </button>
          </div>
        </aside>
      </section>

      {removedLine && (
        <div className="posUndo" role="status">
          Removed {removedLine.name}
          <button
            onClick={() => {
              setCart((current) => [...current, removedLine]);
              setRemovedLine(null);
            }}
          >
            UNDO
          </button>
        </div>
      )}
      {aiCalls.some((call) => call.state === "ai") && (
        <aside
          className="posAiCallStrip"
          aria-label="AI phone ordering activity"
        >
          {aiCalls
            .filter((call) => call.state === "ai")
            .map((call) => (
              <div key={call.id}>
                <strong>AI ORDERING · LINE {call.line_number || "TEST"}</strong>
                <span>
                  {call.display_name || "Unknown caller"}
                  {call.caller_phone ? ` · ${call.caller_phone}` : ""}
                </span>
                <span>
                  {call.open_order_number
                    ? `Order #${call.open_order_number}`
                    : "Building order…"}
                </span>
                {call.open_order_id && (
                  <div className="posAiOrderPreview">
                    <b>
                      {(call.service_type || "order")
                        .replaceAll("_", " ")
                        .toUpperCase()}
                    </b>
                    {call.order_items.length ? (
                      <ul>
                        {call.order_items.map((item) => (
                          <li key={item.id}>
                            <span>
                              {item.quantity}× {item.name}
                              {item.variant ? ` · ${item.variant}` : ""}
                            </span>
                            <em>{money(item.lineTotalCents)}</em>
                            {item.modifiers.length > 0 && (
                              <small>
                                {item.modifiers
                                  .map(
                                    (modifier) =>
                                      `${modifier.quantity > 1 ? `${modifier.quantity}× ` : ""}${modifier.name}`,
                                  )
                                  .join(", ")}
                              </small>
                            )}
                            {item.instructions && (
                              <small>{item.instructions}</small>
                            )}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <small>Waiting for the first item…</small>
                    )}
                    <footer>
                      <span>
                        Subtotal {money(call.subtotal_cents || 0)} · Tax{" "}
                        {money(call.tax_cents || 0)}
                      </span>
                      <strong>Total {money(call.total_cents || 0)}</strong>
                    </footer>
                  </div>
                )}
                <div className="posAiActivity" aria-live="polite">
                  <b>LIVE PROCESSING</b>
                  {call.activities.length ? (
                    <ol>
                      {call.activities.slice(-12).map((activity) => (
                        <li className={activity.role} key={activity.id}>
                          <time>
                            {new Date(activity.createdAt).toLocaleTimeString(
                              [],
                              {
                                hour: "numeric",
                                minute: "2-digit",
                                second: "2-digit",
                              },
                            )}
                          </time>
                          <span>
                            <strong>{activity.label}</strong>
                            {activity.detail && (
                              <small>{activity.detail}</small>
                            )}
                          </span>
                          {activity.durationMs != null && (
                            <em>{activity.durationMs} ms</em>
                          )}
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <small>Connecting to live call telemetry…</small>
                  )}
                </div>
              </div>
            ))}
        </aside>
      )}
      {intervention && (
        <div className="posModalBackdrop">
          <section
            className="posCustomerDialog posIncomingCall"
            role="dialog"
            aria-modal="true"
            aria-label="Phone order intervention required"
          >
            <header>
              <div>
                <span>
                  EMPLOYEE INTERVENTION · LINE{" "}
                  {intervention.line_number || "TEST"}
                </span>
                <h2>
                  {intervention.display_name ||
                    intervention.caller_phone ||
                    "Unknown caller"}
                </h2>
              </div>
            </header>
            <p>
              {intervention.handoff_reason ||
                "The AI transferred this call to the physical deli phones."}
            </p>
            {intervention.open_order_number && (
              <p>
                <strong>Order #{intervention.open_order_number}</strong> ·{" "}
                {intervention.open_order_status?.replaceAll("_", " ")}
              </p>
            )}
            {intervention.open_order_id && (
              <div className="posAiOrderPreview posHandoffOrderPreview">
                <b>{(intervention.service_type || "order").replaceAll("_", " ").toUpperCase()} · ORDER SO FAR</b>
                {intervention.order_items.length ? (
                  <ul>
                    {intervention.order_items.map((item) => (
                      <li key={item.id}>
                        <span>{item.quantity}× {item.name}{item.variant ? ` · ${item.variant}` : ""}</span>
                        <em>{money(item.lineTotalCents)}</em>
                        {item.modifiers.length > 0 && <small>{item.modifiers.map((modifier) => `${modifier.quantity > 1 ? `${modifier.quantity}× ` : ""}${modifier.name}`).join(", ")}</small>}
                        {item.instructions && <small>{item.instructions}</small>}
                      </li>
                    ))}
                  </ul>
                ) : <small>No items have been captured yet.</small>}
                <footer><span>Subtotal {money(intervention.subtotal_cents || 0)} · Tax {money(intervention.tax_cents || 0)}</span><strong>Total {money(intervention.total_cents || 0)}</strong></footer>
              </div>
            )}
            {intervention.claimed_by &&
            intervention.claimed_by !== posEmployeeId ? (
              <p>
                <strong>Claimed on another POS.</strong> This screen is
                read-only.
              </p>
            ) : intervention.claimed_by === posEmployeeId ? (
              <>
                {intervention.open_order_id && (
                  <a
                    className="primary"
                    href={`/pos/deli/orders?orderId=${encodeURIComponent(intervention.open_order_id)}`}
                  >
                    OPEN CURRENT ORDER
                  </a>
                )}
                <button
                  onClick={() => void updateAiCall(intervention, "release")}
                >
                  RELEASE TO ANOTHER POS
                </button>
                <button
                  onClick={() => void updateAiCall(intervention, "complete")}
                >
                  CALL FINISHED
                </button>
              </>
            ) : (
              <button
                className="primary"
                onClick={() => void updateAiCall(intervention, "claim")}
              >
                CLAIM ORDER INTERVENTION
              </button>
            )}
            <small>
              Answer and speak on the physical cordless phone. This iPad never
              carries call audio.
            </small>
          </section>
        </div>
      )}
      {reopenedCancelItem && savedDraft?.reopened && (
        <div className="posModalBackdrop" role="presentation">
          <section className="posCustomerDialog posReopenedVoidDialog" role="dialog" aria-modal="true" aria-label="Void existing order item">
            <ItemCancellationPanel
              orderId={savedDraft.id}
              item={reopenedCancelItem}
              onClose={() => setReopenedCancelItem(null)}
              onDone={async () => {
                setReopenedCancelItem(null);
                await refreshReopenedOrder(savedDraft.id);
                setCartNotice(`Item voided from order #${savedDraft.displayNumber}.`);
              }}
            />
          </section>
        </div>
      )}
      {incomingCall && (
        <div className="posModalBackdrop">
          <section
            className="posCustomerDialog posIncomingCall"
            role="dialog"
            aria-modal="true"
            aria-label="Incoming deli call"
          >
            <header>
              <div>
                <span>
                  INCOMING DELI CALL
                  {incomingCall.line_number
                    ? ` · LINE ${incomingCall.line_number}`
                    : ""}
                </span>
                <h2>
                  {incomingCall.display_name || incomingCall.caller_phone}
                </h2>
              </div>
            </header>
            <strong>{incomingCall.caller_phone}</strong>
            {incomingCall.open_order_id ? (
              <>
                <p>
                  Existing order #{incomingCall.open_order_number} ·{" "}
                  {incomingCall.open_order_status?.replaceAll("_", " ")}
                </p>
                <a
                  className="primary"
                  href={`/pos/deli/orders?orderId=${encodeURIComponent(incomingCall.open_order_id)}`}
                  onClick={(event) => {
                    event.preventDefault();
                    const href = event.currentTarget.href;
                    void acknowledgeIncomingCall().then(() => {
                      window.location.href = href;
                    });
                  }}
                >
                  OPEN EXISTING ORDER
                </a>
              </>
            ) : (
              <button
                className="primary"
                onClick={() => void acknowledgeIncomingCall(true)}
              >
                {incomingCall.customer_id
                  ? "USE CUSTOMER / START ORDER"
                  : "ADD CALLER / START ORDER"}
              </button>
            )}
            <button onClick={() => void acknowledgeIncomingCall()}>
              ANSWERED / DISMISS POPUP
            </button>
            <small>Answer the call on the physical phone.</small>
          </section>
        </div>
      )}
      {helcimOpen && (
        <div className="posSecurePaymentBackdrop" role="status" aria-live="polite">
          <div><span>SECURE CARD PAYMENT</span><strong>Loading Helcim…</strong></div>
        </div>
      )}
      {checkoutOpen && (savedDraft || activeTab) && (
        <div className="posModalBackdrop" role="presentation">
          <section
            className="posCustomerDialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="checkout-title"
          >
            <h2 id="checkout-title">
              Checkout · Order #{(savedDraft || activeTab)!.displayNumber}
            </h2>
            <nav aria-label="Payable checks">
              {payableChecks.map((check) => (
                <button
                  type="button"
                  key={check.id}
                  className={selectedCheckId === check.id ? "selected" : ""}
                  onClick={() => void selectCheck(check.id)}
                >
                  CHECK {check.display_sequence} ·{" "}
                  {money(Number(check.amount_due_cents))} DUE
                </button>
              ))}
            </nav>
            <p>Amount due</p>
            <strong>
              {money(
                Number(
                  checkoutState?.check?.amount_due_cents ??
                    checkoutState?.order.amount_due_cents ??
                    (savedDraft || activeTab)!.totalCents,
                ),
              )}
            </strong>
            {checkoutError && <div className="posCheckoutInlineError" role="alert">{checkoutError}</div>}
            {payableChecks
              .find((check) => check.id === selectedCheckId)
              ?.lines.map((line) => (
                <div key={line.order_item_id}>
                  <span>
                    {line.quantity}× {line.item_name_snapshot} ·{" "}
                    {money(Number(line.allocated_cents))}
                  </span>
                  {Number(checkoutState?.order.paid_cents || 0) === 0 && (
                    <button
                      type="button"
                      disabled={paymentBusy}
                      onClick={() =>
                        void splitOne(selectedCheckId!, line.order_item_id)
                      }
                    >
                      MOVE ONE TO NEW CHECK
                    </button>
                  )}
                </div>
              ))}
            {checkoutState?.tenders.map((tender) => {
              const reversed = checkoutState.tenders
                  .filter(
                    (row) =>
                      row.transaction_type === "void" &&
                      row.related_transaction_id === tender.id,
                  )
                  .reduce((sum, row) => sum + Number(row.amount_cents), 0),
                available = Number(tender.amount_cents) - reversed;
              return (
                <div key={tender.id}>
                  <span>
                    {tender.transaction_type === "void"
                      ? "REVERSAL"
                      : tender.tender_type.toUpperCase()}{" "}
                    · {money(Number(tender.amount_cents))}
                  </span>
                  {tender.reason && <small>{tender.reason}</small>}
                  {Number(tender.change_due_cents) > 0 && (
                    <small>
                      Change {money(Number(tender.change_due_cents))}
                    </small>
                  )}
                  {tender.transaction_type === "payment" && (
                    <>
                      <button
                        type="button"
                        disabled={paymentBusy}
                        onClick={() =>
                          void paymentOperation(
                            "reprint",
                            tender.id,
                            Number(tender.amount_cents),
                          )
                        }
                      >
                        REPRINT RECEIPT
                      </button>
                      {canManagePayments && available > 0 && (
                        <button
                          type="button"
                          disabled={paymentBusy}
                          onClick={() =>
                            void paymentOperation(
                              "reverse",
                              tender.id,
                              available,
                            )
                          }
                        >
                          VOID / REVERSE
                        </button>
                      )}
                    </>
                  )}
                </div>
              );
            })}
            {lastChangeDueCents !== null && (
              <div className="posChangeBackdrop">
                <section
                  className="posChangeWindow"
                  role="alertdialog"
                  aria-modal="true"
                  aria-labelledby="change-due-title"
                >
                  <small id="change-due-title">CHANGE TO GIVE BACK</small>
                  <strong>{money(lastChangeDueCents)}</strong>
                  {lastChangeDueCents === 0 && (
                    <span>Exact cash received — no change.</span>
                  )}
                  <button
                    type="button"
                    autoFocus
                    onClick={() => setLastChangeDueCents(null)}
                  >
                    DONE
                  </button>
                </section>
              </div>
            )}
            {Number(
              checkoutState?.check?.amount_due_cents ??
                checkoutState?.order.amount_due_cents ??
                0,
            ) > 0 && (
              <>
                {stationProfile?.station_mode === "order_taker" && (
                  <section className="posOrderTakerPaymentNotice">
                    <strong>ORDER-TAKING STATION</strong>
                    <span>Payments are handled at the designated front register.</span>
                    <button type="button" disabled={paymentBusy} onClick={() => void sendToPaymentStation()}>
                      {paymentBusy ? "SENDING…" : "SEND TO PAYMENT STATION"}
                    </button>
                  </section>
                )}
                <div className="posCheckoutPaymentGrid">
                  <section
                    className="posCashPanel"
                    aria-labelledby="cash-panel-title"
                  >
                    <h3 id="cash-panel-title">Payment amount</h3>
                    <output aria-live="polite">
                      {cashTender
                        ? money(Math.round(Number(cashTender) * 100) || 0)
                        : "$0.00"}
                    </output>
                    <div
                      className="posCashQuick"
                      aria-label="Quick payment amounts"
                    >
                      <button
                        type="button"
                        onClick={() => setQuickCash(checkoutDueCents)}
                      >
                        EXACT
                      </button>
                      {[2000, 5000, 10000].map((amount) => (
                        <button
                          type="button"
                          key={amount}
                          onClick={() => setQuickCash(amount)}
                        >
                          {money(amount)}
                        </button>
                      ))}
                    </div>
                    <div
                      className="posCashNumpad"
                      aria-label="Payment amount keypad"
                    >
                      {[
                        "1",
                        "2",
                        "3",
                        "4",
                        "5",
                        "6",
                        "7",
                        "8",
                        "9",
                        "clear",
                        "0",
                        ".",
                        "backspace",
                      ].map((key) => (
                        <button
                          type="button"
                          key={key}
                          className={key === "0" ? "zero" : ""}
                          aria-label={
                            key === "backspace"
                              ? "Backspace"
                              : key === "clear"
                                ? "Clear payment amount"
                                : key
                          }
                          onClick={() => cashNumpad(key)}
                        >
                          {key === "backspace"
                            ? "⌫"
                            : key === "clear"
                              ? "CLEAR"
                              : key}
                        </button>
                      ))}
                    </div>
                  </section>
                  <section
                    className="posOtherTenders"
                    aria-labelledby="other-tenders-title"
                  >
                    <h3 id="other-tenders-title">Gift card</h3>
                    <label>
                      Gift card number
                      <input
                        ref={giftCardInputRef}
                        data-barcode-context="gift-card"
                        autoComplete="off"
                        value={giftCardNumber}
                        onChange={(event) =>
                          setGiftCardNumber(event.target.value)
                        }
                      />
                    </label>
                    <p>The card will apply up to the selected amount or its available balance, whichever is less.</p>
                  </section>
                </div>
                <div className="posTenderButtons" aria-label="Choose payment type">
                  <button type="button" disabled={paymentBusy || !cashTender || stationProfile?.station_mode === "order_taker"} onClick={() => void commitPayment("cash")}>CASH</button>
                  <button type="button" disabled={paymentBusy || !helcimStatus?.checkoutEnabled || stationProfile?.station_mode === "order_taker"} onClick={chooseCredit}>
                    {helcimStatus?.checkoutEnabled ? "CREDIT" : "CREDIT SETUP REQUIRED"}
                  </button>
                  <button type="button" disabled={paymentBusy || stationProfile?.station_mode === "order_taker"} onClick={() => validGiftCardInput(giftCardNumber) ? void commitPayment("gift_card") : giftCardInputRef.current?.focus()}>GIFT CARD</button>
                </div>
                {helcimStatus?.localDevelopment && canManagePayments && (
                  <button type="button" disabled={paymentBusy || stationProfile?.station_mode === "order_taker"} onClick={() => void commitTestCard()}>
                    {paymentBusy ? "PROCESSING…" : "APPROVE TEST CARD"}
                  </button>
                )}
                {tipPromptOpen && (
                  <div className="posChangeBackdrop">
                    <section className="posTipWindow" role="dialog" aria-modal="true" aria-labelledby="tip-title">
                      <small>MANUAL CARD ENTRY</small>
                      <h2 id="tip-title">Add a tip?</h2>
                      <div className="posTipChoices">
                        {[15,18,20].map(percent => <button type="button" key={percent} onClick={() => void applyTipAndStartCard(Math.round(checkoutDueCents * percent / 100))}>{percent}%<span>{money(Math.round(checkoutDueCents * percent / 100))}</span></button>)}
                        <button type="button" onClick={() => void applyTipAndStartCard(0)}>NO TIP</button>
                      </div>
                      <label>Custom tip<input autoFocus type="number" inputMode="decimal" min="0" step="0.01" value={customTip} onChange={event=>setCustomTip(event.target.value)}/></label>
                      <button type="button" disabled={!customTip || Number(customTip)<0} onClick={() => void applyTipAndStartCard(Math.round(Number(customTip)*100))}>ADD CUSTOM TIP</button>
                      <button type="button" onClick={() => setTipPromptOpen(false)}>CANCEL</button>
                    </section>
                  </div>
                )}
              </>
            )}
            {checkoutState?.order.payment_status === "paid" && (
              <>
                <strong>PAID</strong>
                {business === "Tiki" && activeTab && (
                  <button
                    type="button"
                    className="primary"
                    disabled={submittingOrder}
                    onClick={() => void submitOrder(activeTab)}
                  >
                    {submittingOrder ? "CLOSING…" : "CLOSE TAB"}
                  </button>
                )}
              </>
            )}
            <button type="button" onClick={closeCheckout}>
              {savedDraft?.checkoutOnly ? "BACK TO ORDERS" : "BACK TO ORDER"}
            </button>
          </section>
        </div>
      )}
      {tabsOpen && (
        <div
          className="posModalBackdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setTabsOpen(false);
          }}
        >
          <section
            className="posCustomerDialog posTabsDialog"
            role="dialog"
            aria-modal="true"
            aria-label="Open Tiki bar tabs"
          >
            <header>
              <div>
                <span>TIKI</span>
                <h2>Open bar tabs</h2>
              </div>
              <button type="button" onClick={() => setTabsOpen(false)}>
                Close
              </button>
            </header>
            {tabsLoading ? (
              <p>Loading tabs…</p>
            ) : openTabs.length ? (
              openTabs.map((tab) => (
                <button
                  type="button"
                  className="posTabChoice"
                  key={tab.id}
                  onClick={() => void chooseTab(tab)}
                >
                  <strong>
                    {tab.tab_name || `Tab #${tab.display_number}`}
                  </strong>
                  <span>
                    #{tab.display_number} · {tab.item_count} items ·{" "}
                    {money(Number(tab.amount_due_cents))} due
                  </span>
                </button>
              ))
            ) : (
              <p>No open Tiki tabs.</p>
            )}
          </section>
        </div>
      )}
      {unknownBarcode && (
        <div className="posModalBackdrop" role="presentation">
          <section
            className="posCustomerDialog"
            role="dialog"
            aria-modal="true"
            aria-label="Unknown barcode"
          >
            <header>
              <div>
                <span>BARCODE</span>
                <h2>Unknown barcode</h2>
              </div>
              <button type="button" onClick={() => setUnknownBarcode("")}>
                Close
              </button>
            </header>
            <p>
              <strong>{unknownBarcode}</strong> is not mapped to merchandise for{" "}
              {business}. No item or gift card action was taken.
            </p>
            {!canManageBarcodes ? (
              <p>A manager or owner must create barcode mappings.</p>
            ) : (
              <>
                <label>
                  Map to item
                  <select
                    value={mappingItemId}
                    onChange={(event) => {
                      setMappingItemId(event.target.value);
                      setMappingVariantId("");
                    }}
                  >
                    <option value="">Choose an item</option>
                    {allItems.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
                {allItems.find((item) => item.id === mappingItemId)?.variants
                  .length ? (
                  <label>
                    Specific variant (optional)
                    <select
                      value={mappingVariantId}
                      onChange={(event) =>
                        setMappingVariantId(event.target.value)
                      }
                    >
                      <option value="">Item default / no variant</option>
                      {allItems
                        .find((item) => item.id === mappingItemId)!
                        .variants.map((variant) => (
                          <option key={variant.id} value={variant.id}>
                            {variant.name}
                          </option>
                        ))}
                    </select>
                  </label>
                ) : null}
                <button
                  type="button"
                  className="primary"
                  disabled={!mappingItemId || mappingBusy}
                  onClick={() => void mapUnknownBarcode()}
                >
                  {mappingBusy ? "SAVING…" : "SAVE MAPPING"}
                </button>
              </>
            )}
          </section>
        </div>
      )}
      {configuringItem && (
        <div
          className={
            configuringItem.modifiers.some(
              (group) => group.presentationBehavior === "pizza_topping",
            )
              ? "posInlineConfigHost"
              : "posModalBackdrop"
          }
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setConfiguringItem(null);
          }}
        >
          <section
            className="posConfigModal"
            role="dialog"
            aria-modal={
              configuringItem.modifiers.some(
                (group) => group.presentationBehavior === "pizza_topping",
              )
                ? undefined
                : "true"
            }
            aria-label={`Configure ${configuringItem.name}`}
          >
            <header>
              <div>
                <span>Configure item</span>
                <h2>{configuringItem.name}</h2>
                <p>{configuringItem.description}</p>
              </div>
              <button type="button" onClick={() => setConfiguringItem(null)}>
                Close
              </button>
            </header>
            <div className="posConfigBody">
              {configuringItem.variants.filter((variant) => variant.available).length > 1 && (
                <fieldset
                  id="variant-choice"
                  className={!selectedVariant ? "needsSelection" : ""}
                >
                  <legend>
                    Size / form
                    <small>
                      Required · only valid forms for this item are shown
                    </small>
                  </legend>
                  <div className="posChoiceGrid">
                    {configuringItem.variants.filter((variant) => variant.available).map((variant) => (
                      <button
                        key={variant.id}
                        type="button"
                        disabled={!variant.available}
                        className={
                          selectedVariantId === variant.id ? "selected" : ""
                        }
                        onClick={() => chooseVariant(variant)}
                      >
                        <strong>{variant.name}</strong>
                        <span>
                          {variant.available
                            ? money(variant.basePriceCents)
                            : "Unavailable"}
                        </span>
                      </button>
                    ))}
                  </div>
                </fieldset>
              )}

              {configuringItem.modifiers
                .filter((group) => group.presentationBehavior === "pizza_topping" && modifierGroupVisible(group))
                .map((group) => (
                  <PizzaToppingSelector
                    key={group.id}
                    group={group}
                    variant={selectedVariant}
                    selections={pizzaToppings}
                    onChange={setPizzaToppings}
                    interaction="portion_first"
                  />
                ))}

              {configuringItem.modifiers.some(
                (group) => group.presentationContext === "combo_trigger",
              ) && (
                <fieldset>
                  <legend>
                    Make It A Combo<small>Optional</small>
                  </legend>
                  <div className="posChoiceGrid">
                    <button
                      type="button"
                      className={presentationComboEnabled ? "selected" : ""}
                      onClick={() => {
                        setPresentationComboEnabled((value) => !value);
                        if (presentationComboEnabled)
                          setModifierSelections((current) =>
                            Object.fromEntries(
                              Object.entries(current).map(
                                ([id, selections]) => [
                                  id,
                                  configuringItem.modifiers.some(
                                    (group) =>
                                      group.id === id &&
                                      (group.presentationContext ===
                                        "combo_trigger" ||
                                        group.presentationContext ===
                                          "dependent"),
                                  )
                                    ? []
                                    : selections,
                                ],
                              ),
                            ),
                          );
                      }}
                    >
                      <strong>
                        {presentationComboEnabled
                          ? "Combo selected"
                          : "MAKE IT A COMBO"}
                      </strong>
                      <span>
                        {presentationComboEnabled
                          ? "Choose a side below"
                          : "Add a side"}
                      </span>
                    </button>
                  </div>
                </fieldset>
              )}

              {configuringItem.modifiers
                .filter((group) => group.presentationBehavior !== "pizza_topping")
                .filter(modifierGroupVisible)
                .toSorted(
                  (left, right) => left.componentOrder - right.componentOrder,
                )
                .map((group) => {
                  const selected = modifierSelections[group.id] || [];
                  const valid = selectionsValid(group, selected);
                  return (
                    <fieldset
                      id={`modifier-${group.id}`}
                      key={group.id}
                      data-component={group.componentKey || undefined}
                      className={`${!valid ? "needsSelection " : ""}${group.presentationStyle === "component_columns" ? "posMealComponent" : group.presentationStyle === "universal" ? "posMealUniversal" : ""}`}
                    >
                      <legend>
                        {group.componentLabel || group.prompt || group.name}
                        <small>
                          {group.minSelections > 0 ? "Required" : "Optional"} ·
                          choose{" "}
                          {group.minSelections === group.maxSelections
                            ? group.maxSelections
                            : `${group.minSelections}-${group.maxSelections}`}
                          {group.presentationContext === "dependent"
                            ? " · shown by its parent selection"
                            : ""}
                        </small>
                      </legend>
                      <div className="posChoiceGrid">
                        {group.options.map((option) => {
                          const available = variantOptionAvailable(
                            selectedVariant,
                            option,
                          );
                          const baseDeltaCents = variantOptionPrice(
                            selectedVariant,
                            option,
                          );
                          const selectedOrdinal = group.options
                            .filter((candidate) =>
                              selected.includes(candidate.id),
                            )
                            .findIndex(
                              (candidate) => candidate.id === option.id,
                            );
                          const priceDeltaCents =
                            group.includedChoiceCount > 0 &&
                            !modifierDeclines.includes(group.id) &&
                            (selected.length < group.includedChoiceCount ||
                              (selectedOrdinal >= 0 &&
                                selectedOrdinal < group.includedChoiceCount))
                              ? 0
                              : baseDeltaCents;
                          const selectedOption = selected.includes(option.id);
                          return (
                            <div className="posModifierChoice" key={option.id}>
                              <button
                                type="button"
                                disabled={!available}
                                className={selectedOption ? "selected" : ""}
                                onPointerDown={() =>
                                  beginIntensityHold(group, option)
                                }
                                onPointerUp={endIntensityHold}
                                onPointerCancel={endIntensityHold}
                                onPointerLeave={endIntensityHold}
                                onContextMenu={(event) => {
                                  if (
                                    supportsSubModifierIntensity(
                                      group.supportsIntensity,
                                      option.name,
                                    )
                                  ) {
                                    event.preventDefault();
                                    setIntensityChoice({ group, option });
                                  }
                                }}
                                onClick={() => {
                                  if (held.current) {
                                    held.current = false;
                                    return;
                                  }
                                  toggleModifier(group, option.id);
                                }}
                              >
                                <strong>{option.name}</strong>
                                <span>
                                  {!available
                                    ? "Unavailable for this size/form"
                                    : priceDeltaCents
                                      ? `${priceDeltaCents > 0 ? "+" : ""}${money(priceDeltaCents)}`
                                      : option.defaultSelected
                                        ? "FREE · Default"
                                        : "FREE"}
                                </span>
                              </button>
                              {selectedOption &&
                                supportsSubModifierIntensity(
                                  group.supportsIntensity,
                                  option.name,
                                ) && (
                                  <button
                                    type="button"
                                    className="posAmountButton"
                                    aria-label={`Change ${option.name} amount, currently ${modifierAmounts[option.id] || "normal"}`}
                                    onClick={() =>
                                      setIntensityChoice({ group, option })
                                    }
                                  >
                                    {(
                                      modifierAmounts[option.id] || "normal"
                                    ).toUpperCase()}{" "}
                                    ▾
                                  </button>
                                )}
                              {selectedOption && group.allowOptionQuantity && (
                                <div
                                  className="posModifierQty"
                                  aria-label={`${option.name} quantity`}
                                >
                                  <button
                                    type="button"
                                    onClick={() =>
                                      changeModifierQuantity(option.id, -1)
                                    }
                                    aria-label={`Decrease ${option.name}`}
                                  >
                                    −
                                  </button>
                                  <strong>
                                    {modifierQuantities[option.id] || 1}
                                  </strong>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      changeModifierQuantity(option.id, 1)
                                    }
                                    aria-label={`Increase ${option.name}`}
                                  >
                                    +
                                  </button>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                      {group.includedChoiceCount > 0 && (
                        <button
                          type="button"
                          className={
                            modifierDeclines.includes(group.id)
                              ? "selected"
                              : ""
                          }
                          onClick={() => {
                            setModifierDeclines((current) =>
                              current.includes(group.id)
                                ? current.filter((id) => id !== group.id)
                                : [...current, group.id],
                            );
                            setModifierSelections((current) => ({
                              ...current,
                              [group.id]: [],
                            }));
                          }}
                        >
                          NO INCLUDED CHOICE
                        </button>
                      )}
                    </fieldset>
                  );
                })}

              {configuringItem.combos.length > 0 && (
                <fieldset>
                  <legend>
                    Combo options<small>Optional unless selected</small>
                  </legend>
                  <div className="posChoiceGrid">
                    <button
                      type="button"
                      className={!selectedComboId ? "selected" : ""}
                      onClick={() => chooseCombo(null)}
                    >
                      <strong>No combo</strong>
                      <span>Item only</span>
                    </button>
                    {configuringItem.combos.map((combo) => (
                      <button
                        key={combo.id}
                        type="button"
                        className={
                          selectedComboId === combo.id ? "selected" : ""
                        }
                        onClick={() => chooseCombo(combo)}
                      >
                        <strong>{combo.name}</strong>
                        <span>
                          {combo.basePriceDeltaCents
                            ? `+${money(combo.basePriceDeltaCents)}`
                            : "FREE"}
                        </span>
                      </button>
                    ))}
                  </div>
                </fieldset>
              )}

              {selectedCombo?.groups.map((group) => {
                const selected = comboSelections[group.id] || [];
                const valid =
                  selected.length >= group.minSelections &&
                  selected.length <= group.maxSelections;
                return (
                  <fieldset
                    id={`combo-${group.id}`}
                    key={group.id}
                    className={!valid ? "needsSelection" : ""}
                  >
                    <legend>
                      {group.prompt || group.name}
                      <small>Required combo choice</small>
                    </legend>
                    <div className="posChoiceGrid">
                      {group.options.map((option) => (
                        <button
                          key={option.id}
                          type="button"
                          disabled={!option.available}
                          className={
                            selected.includes(option.id) ? "selected" : ""
                          }
                          onClick={() =>
                            toggleComboOption(
                              group.id,
                              group.maxSelections,
                              option.id,
                            )
                          }
                        >
                          <strong>{option.name}</strong>
                          <span>
                            {option.priceDeltaCents
                              ? `+${money(option.priceDeltaCents)}`
                              : "FREE"}
                          </span>
                        </button>
                      ))}
                    </div>
                  </fieldset>
                );
              })}
              <label className="posItemNotes">
                Item notes
                <textarea
                  value={specialInstructions}
                  maxLength={500}
                  placeholder="Kitchen note (optional)"
                  onChange={(event) =>
                    setSpecialInstructions(event.target.value)
                  }
                />
              </label>
            </div>
            <footer>
              <div>
                <span>Configured price</span>
                <strong>{money(configuration.unitPriceCents)}</strong>
              </div>
              <div className="posConfigActions">
                {(!configuration.valid || configurationMessage) && (
                  <div className="posConfigurationMissing" role="alert">
                    {configuration.missing.map((issue) => (
                      <span key={issue.id}>{issue.message}</span>
                    ))}
                  </div>
                )}
                <button type="button" onClick={() => setConfiguringItem(null)}>
                  CANCEL
                </button>
                <button
                  type="button"
                  className={`primary ${configuration.valid ? "" : "invalid"}`}
                  aria-disabled={!configuration.valid}
                  onClick={addConfiguredItem}
                >
                  {editingLineId ? "UPDATE ITEM" : "ADD TO ORDER"}
                </button>
              </div>
            </footer>
          </section>
        </div>
      )}
      {intensityChoice && (
        <div
          className="posIntensityPopover"
          role="dialog"
          aria-label={`${intensityChoice.option.name} amount`}
        >
          <strong>{intensityChoice.option.name}</strong>
          <div>
            {(["light", "normal", "heavy"] as const).map((amount) => (
              <button
                key={amount}
                className={
                  (modifierAmounts[intensityChoice.option.id] || "normal") ===
                  amount
                    ? "selected"
                    : ""
                }
                onClick={() => chooseIntensity(amount)}
              >
                {amount.toUpperCase()}
              </button>
            ))}
          </div>
          <button onClick={() => setIntensityChoice(null)}>Cancel</button>
        </div>
      )}
      {customerOpen && (
        <div
          className="posModalBackdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setCustomerOpen(false);
          }}
        >
          <section
            className="posCustomerDialog"
            role="dialog"
            aria-modal="true"
          >
            <header>
              <div>
                <span>CUSTOMER</span>
                <h2>Find or add customer</h2>
              </div>
              <button onClick={() => setCustomerOpen(false)}>Close</button>
            </header>
            <label>
              Search existing customer
              <input
                autoFocus
                type="search"
                value={customerQuery}
                onChange={(e) => setCustomerQuery(e.target.value)}
                placeholder="3155551212 or Sarah Smith"
              />
            </label>
            {customerMatches.map((match) => (
              <button
                className="posCustomerMatch"
                key={match.id}
                onClick={() => {
                  chooseCustomer(match);
                  setCustomerOpen(false);
                }}
              >
                <strong>{match.display_name}</strong>
                <span>
                  {match.phones
                    ?.map((phone) => phone.display_phone)
                    .join(" · ") || match.display_phone}
                </span>
                {match.addresses[0] && (
                  <small>
                    {match.addresses[0].line1} · Last order{" "}
                    {match.last_order_at
                      ? new Date(match.last_order_at).toLocaleDateString()
                      : "never"}
                  </small>
                )}
              </button>
            ))}
            {business === "Corner Deli" && (
              <form className="posQuickCustomer" onSubmit={createQuickCustomer}>
                <h3>Quick add</h3>
                <div>
                  <label>
                    First name
                    <input
                      required
                      maxLength={80}
                      autoComplete="off"
                      value={quickCustomer.firstName}
                      onChange={(e) =>
                        setQuickCustomer((current) => ({
                          ...current,
                          firstName: e.target.value,
                        }))
                      }
                    />
                  </label>
                  <label>
                    Last name
                    <input
                      maxLength={80}
                      autoComplete="off"
                      value={quickCustomer.lastName}
                      onChange={(e) =>
                        setQuickCustomer((current) => ({
                          ...current,
                          lastName: e.target.value,
                        }))
                      }
                    />
                  </label>
                </div>
                <label>
                  Phone number
                  <input
                    required
                    inputMode="tel"
                    autoComplete="tel"
                    placeholder="315-555-1212"
                    value={quickCustomer.phone}
                    onChange={(e) =>
                      setQuickCustomer((current) => ({
                        ...current,
                        phone: e.target.value,
                      }))
                    }
                  />
                </label>
                {quickCustomerError && <p role="alert">{quickCustomerError}</p>}
                <button
                  className="primary"
                  disabled={
                    quickCustomerBusy ||
                    !quickCustomer.firstName.trim() ||
                    quickCustomer.phone.replace(/\D/g, "").length !== 10
                  }
                >
                  {quickCustomerBusy ? "SAVING…" : "ADD TO ORDER"}
                </button>
              </form>
            )}
            {customer && (
              <button
                className="danger"
                onClick={() => {
                  setCustomer(null);
                  setSelectedCustomerPhoneId("");
                  setSelectedCustomerAddressId("");
                  setCustomerOpen(false);
                  setSavedDraft(null);
                }}
              >
                Clear customer
              </button>
            )}
            {business === "Corner Deli" && (
              <Link
                href="/pos/deli/customers"
                onClick={() => setCustomerOpen(false)}
              >
                Open customer CRM
              </Link>
            )}
          </section>
        </div>
      )}
    </main>
  );
}

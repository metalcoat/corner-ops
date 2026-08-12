"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Business, SessionView } from "@/lib/types";
import PosPinGate, { type PosEmployeeSession, type PosSessionView } from "./pos-pin-gate";
import type { ServiceType } from "@/lib/ordering-core";
import type { OrderTimingMode } from "@/lib/ordering-timing-core";
import { orderingBusinessConfig, type PosUtility } from "@/lib/ordering-business-config";
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
  comboId: string | null;
  comboSelections: Record<string, string[]>;
  specialInstructions: string;
};

type MenuPayload = {
  business: Business;
  categories: OrderingMenuCategoryWithVariants[];
};

type SavedDraft = {
  id: string;
  displayNumber: string;
  totalCents: number;
  timingMessage: string;
  kitchenTimingLabel: string;
  scheduledFor: string | null;
};

type SubmittedOrder = {
  displayNumber: string;
  totalCents: number;
};

type AddressSuggestion = { id: string; text: string; mainText: string; secondaryText: string; provider: "google" };
type ValidatedAddress = { formattedAddress: string; city: string; state: string; postalCode: string };
type DeliveryRoute = { distanceMiles: number; durationSeconds: number; provider: string; calculatedAt: string };

const serviceLabels: Record<PosServiceType, { label: string; paymentNote?: string }> = {
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
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

function cloneSelections(value: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(value).map(([key, ids]) => [key, [...ids]]));
}

function clientId(): string {
  const bytes = new Uint8Array(16);
  window.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function variantOptionPrice(
  variant: OrderingItemVariantView | null,
  option: OrderingModifierOptionView,
): number {
  const override = variant?.modifierPrices.find((price) => price.optionId === option.id);
  return override ? override.priceDeltaCents : option.priceDeltaCents;
}

function variantOptionAvailable(
  variant: OrderingItemVariantView | null,
  option: OrderingModifierOptionView,
): boolean {
  const override = variant?.modifierPrices.find((price) => price.optionId === option.id);
  return option.available && (override ? override.available : true);
}

function initialVariant(item: OrderingMenuItemWithVariants): OrderingItemVariantView | null {
  if (!item.variants.length) return null;
  return item.variants.find((variant) => variant.defaultVariant && variant.available)
    || (item.variants.length === 1 && item.variants[0].available ? item.variants[0] : null);
}

function initialModifierSelections(
  item: OrderingMenuItemWithVariants,
  variant: OrderingItemVariantView | null,
): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const group of item.modifiers) {
    result[group.id] = group.options
      .filter((option) => option.defaultSelected && variantOptionAvailable(variant, option))
      .map((option) => option.id);
  }
  return result;
}

function selectionsValid(group: OrderingModifierGroupView, selections: string[]): boolean {
  const count = selections.length;
  return count >= group.minSelections && count <= group.maxSelections;
}

export default function PosClient({ business }: { business: Business }) {
  const config = orderingBusinessConfig(business);
  const availableServices = config.serviceTypes.filter((value): value is PosServiceType => value !== "undecided" && (business !== "Corner Deli" || value === "pickup" || value === "delivery" || value === "dine_in"));
  const [session, setSession] = useState<SessionView | PosSessionView | null>(null);
  const [menu, setMenu] = useState<OrderingMenuCategoryWithVariants[]>([]);
  const [menuLoading, setMenuLoading] = useState(true);
  const [menuError, setMenuError] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [primaryCategoryId, setPrimaryCategoryId] = useState("");
  const [menuSearch, setMenuSearch] = useState("");
  const [serviceType, setServiceType] = useState<PosServiceType>(availableServices[0] || "pickup");
  const [timingMode, setTimingMode] = useState<OrderTimingMode>("asap");
  const [scheduledFor, setScheduledFor] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [configuringItem, setConfiguringItem] = useState<OrderingMenuItemWithVariants | null>(null);
  const [selectedVariantId, setSelectedVariantId] = useState("");
  const [modifierSelections, setModifierSelections] = useState<Record<string, string[]>>({});
  const [modifierQuantities, setModifierQuantities] = useState<Record<string, number>>({});
  const [selectedComboId, setSelectedComboId] = useState("");
  const [comboSelections, setComboSelections] = useState<Record<string, string[]>>({});
  const [specialInstructions, setSpecialInstructions] = useState("");
  const [editingLineId, setEditingLineId] = useState<string | null>(null);
  const [savingDraft, setSavingDraft] = useState(false);
  const [checkoutError, setCheckoutError] = useState("");
  const [savedDraft, setSavedDraft] = useState<SavedDraft | null>(null);
  const [submittingOrder, setSubmittingOrder] = useState(false);
  const [submittedOrder, setSubmittedOrder] = useState<SubmittedOrder | null>(null);
  const [configurationMessage, setConfigurationMessage] = useState("");
  const [cartNotice, setCartNotice] = useState("");
  const [deliveryAddress, setDeliveryAddress] = useState("");
  const [deliveryUnit, setDeliveryUnit] = useState("");
  const [addressSessionToken, setAddressSessionToken] = useState("");
  const [addressSuggestions, setAddressSuggestions] = useState<AddressSuggestion[]>([]);
  const [addressLoading, setAddressLoading] = useState(false);
  const [addressError, setAddressError] = useState("");
  const [activeSuggestion, setActiveSuggestion] = useState(-1);
  const [validatingAddress, setValidatingAddress] = useState(false);
  const [validatedAddress, setValidatedAddress] = useState<ValidatedAddress | null>(null);
  const [deliveryValidationToken, setDeliveryValidationToken] = useState("");
  const [deliveryValidatedInput, setDeliveryValidatedInput] = useState("");
  const [deliveryRoute, setDeliveryRoute] = useState<DeliveryRoute | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.documentElement.dataset.businessTheme = business;
    window.localStorage.setItem("corner-ops-business-theme", business);
    fetch(business === "Corner Deli" ? "/api/pos/session" : "/api/auth/session", { cache: "no-store" })
      .then((response) => response.json())
      .then((payload: SessionView | PosSessionView) => setSession(payload))
      .catch(() => setSession({ authenticated: false } as SessionView));
  }, [business]);

  useEffect(() => { if (!addressSessionToken) setAddressSessionToken(clientId()); }, [addressSessionToken]);

  async function lockPos() {
    await fetch("/api/pos/session", { method: "DELETE" });
    setSession({ authenticated: false });
    setCart([]);
    setSavedDraft(null);
  }

  useEffect(() => {
    if (!session?.authenticated) return;
    let cancelled = false;
    setMenuLoading(true);
    setMenuError("");
    fetch(`/api/ordering/menu?business=${encodeURIComponent(business)}`, { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json() as MenuPayload & { error?: string };
        if (!response.ok) throw new Error(payload.error || "Could not load menu.");
        return payload;
      })
      .then((payload) => {
        if (cancelled) return;
        setMenu(payload.categories || []);
        const primaries = payload.categories.filter((category) => !category.parentId);
        const firstPrimary = primaries.find((category) => category.items.length || payload.categories.some((child) => child.parentId === category.id));
        const firstLeaf = firstPrimary?.presentationOnly ? payload.categories.find((child) => child.parentId === firstPrimary.id) : firstPrimary;
        setPrimaryCategoryId((current) => primaries.some((category) => category.id === current) ? current : firstPrimary?.id || "");
        setCategoryId((current) => payload.categories.some((category) => category.id === current) ? current : firstLeaf?.id || "");
      })
      .catch((error) => {
        if (!cancelled) setMenuError(error instanceof Error ? error.message : "Could not load menu.");
      })
      .finally(() => {
        if (!cancelled) setMenuLoading(false);
      });
    return () => { cancelled = true; };
  }, [business, session?.authenticated]);

  useEffect(() => {
    if (serviceType !== "delivery") return;
    const input = deliveryAddress.trim();
    if (input.length < 2 || validatedAddress) { setAddressSuggestions([]); setAddressLoading(false); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setAddressLoading(true); setAddressError("");
      fetch("/api/ordering/address/suggest", { method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal, body: JSON.stringify({ input, sessionToken: addressSessionToken }) })
        .then(async (response) => { const payload = await response.json() as { suggestions?: AddressSuggestion[]; error?: string }; if (!response.ok) throw new Error(payload.error || "Address suggestions are unavailable."); return payload; })
        .then((payload) => { setAddressSuggestions(payload.suggestions || []); setActiveSuggestion(-1); })
        .catch((error) => { if (error instanceof DOMException && error.name === "AbortError") return; setAddressSuggestions([]); setAddressError(error instanceof Error ? error.message : "Address suggestions are unavailable."); })
        .finally(() => setAddressLoading(false));
    }, 220);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [addressSessionToken, deliveryAddress, serviceType, validatedAddress]);

  const primaryCategories = useMemo(() => menu.filter((category) => !category.parentId && (category.items.length || menu.some((child) => child.parentId === category.id))), [menu]);
  const activePrimary = primaryCategories.find((category) => category.id === primaryCategoryId) || primaryCategories[0];
  const subcategories = activePrimary ? menu.filter((category) => category.parentId === activePrimary.id) : [];
  const activeCategory = menu.find((category) => category.id === categoryId) || (activePrimary?.presentationOnly ? subcategories[0] : activePrimary);
  const allItems = useMemo(() => menu.flatMap((category) => category.items), [menu]);
  const visibleItems = useMemo(() => {
    const query = menuSearch.trim().toLowerCase();
    if (!query) return activeCategory?.items || [];
    return allItems.filter((item) => [item.name, item.description, ...item.variants.flatMap((variant) => [variant.name, ...variant.aliases])].some((value) => value.toLowerCase().includes(query)));
  }, [activeCategory, allItems, menuSearch]);
  const subtotalCents = cart.reduce((sum, line) => sum + line.unitPriceCents * line.quantity, 0);
  const selectedCombo = configuringItem?.combos.find((combo) => combo.id === selectedComboId) || null;
  const selectedVariant = configuringItem?.variants.find((variant) => variant.id === selectedVariantId) || null;

  const configuration = useMemo(() => {
    if (!configuringItem) {
      return { valid: false, unitPriceCents: 0, modifierText: [] as string[], comboText: [] as string[], missing: [] as Array<{ id: string; message: string }> };
    }

    const variantRequired = configuringItem.variants.length > 0;
    let valid = !variantRequired || Boolean(selectedVariant);
    let unitPriceCents = selectedVariant?.basePriceCents ?? configuringItem.basePriceCents;
    const modifierText: string[] = [];
    const comboText: string[] = [];
    const missing: Array<{ id: string; message: string }> = [];
    if (variantRequired && !selectedVariant) missing.push({ id: "variant-choice", message: "Select a size" });

    for (const group of configuringItem.modifiers) {
      const selected = modifierSelections[group.id] || [];
      if (!selectionsValid(group, selected)) {
        valid = false;
        missing.push({ id: `modifier-${group.id}`, message: `Choose ${group.minSelections === group.maxSelections ? group.minSelections : `${group.minSelections}-${group.maxSelections}`} ${group.prompt || group.name}` });
      }
      for (const option of group.options) {
        const chosen = selected.includes(option.id);
        const available = variantOptionAvailable(selectedVariant, option);
        const priceDeltaCents = variantOptionPrice(selectedVariant, option);
        if (chosen && !available) valid = false;
        if (chosen) {
          const optionQuantity = group.allowOptionQuantity ? Math.max(1, modifierQuantities[option.id] || 1) : 1;
          unitPriceCents += priceDeltaCents * optionQuantity;
          if (!option.defaultSelected || priceDeltaCents !== 0) {
            modifierText.push(`${group.name}: ${option.name}${optionQuantity > 1 ? ` ×${optionQuantity}` : ""}`);
          }
        } else if (option.defaultSelected) {
          modifierText.push(`${group.name}: NO ${option.name.toUpperCase()}`);
        }
      }
    }

    if (selectedCombo) {
      unitPriceCents += selectedCombo.basePriceDeltaCents;
      comboText.push(selectedCombo.name);
      for (const group of selectedCombo.groups) {
        const selected = comboSelections[group.id] || [];
        if (selected.length < group.minSelections || selected.length > group.maxSelections) { valid = false; missing.push({ id: `combo-${group.id}`, message: `Choose ${group.minSelections === group.maxSelections ? group.minSelections : `${group.minSelections}-${group.maxSelections}`} ${group.prompt || group.name}` }); }
        for (const option of group.options.filter((candidate) => selected.includes(candidate.id))) {
          unitPriceCents += option.priceDeltaCents;
          comboText.push(`${group.name}: ${option.name}`);
        }
      }
    }

    return { valid, unitPriceCents, modifierText, comboText, missing };
  }, [configuringItem, selectedVariant, modifierSelections, modifierQuantities, selectedCombo, comboSelections]);

  function openItem(item: OrderingMenuItemWithVariants, line?: CartLine) {
    if (!item.available) return;
    const variant = initialVariant(item);
    setConfiguringItem(item);
    const lineVariant = line?.variantId ? item.variants.find((candidate) => candidate.id === line.variantId) || variant : variant;
    setSelectedVariantId(lineVariant?.id || "");
    setModifierSelections(line ? cloneSelections(line.modifierSelections) : initialModifierSelections(item, lineVariant));
    setModifierQuantities(line ? { ...line.modifierQuantities } : {});
    setSelectedComboId(line?.comboId || "");
    setComboSelections(line ? cloneSelections(line.comboSelections) : {});
    setSpecialInstructions(line?.specialInstructions || "");
    setEditingLineId(line?.id || null);
    setCheckoutError("");
    setConfigurationMessage("");
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
    const option = group.options.find((candidate) => candidate.id === optionId);
    if (!option || !variantOptionAvailable(selectedVariant, option)) return;
    setModifierSelections((current) => {
      const existing = current[group.id] || [];
      if (group.maxSelections === 1) {
        return { ...current, [group.id]: existing.includes(optionId) ? [] : [optionId] };
      }
      return {
        ...current,
        [group.id]: existing.includes(optionId)
          ? existing.filter((id) => id !== optionId)
          : [...existing, optionId].slice(0, group.maxSelections),
      };
    });
    setModifierQuantities((current) => ({ ...current, [optionId]: current[optionId] || 1 }));
  }

  function changeModifierQuantity(optionId: string, delta: number) {
    setModifierQuantities((current) => ({ ...current, [optionId]: Math.max(1, Math.min(99, (current[optionId] || 1) + delta)) }));
  }

  function chooseCombo(combo: OrderingComboView | null) {
    setSelectedComboId(combo?.id || "");
    const defaults: Record<string, string[]> = {};
    if (combo) for (const group of combo.groups) defaults[group.id] = [];
    setComboSelections(defaults);
  }

  function toggleComboOption(groupId: string, maxSelections: number, optionId: string) {
    setComboSelections((current) => {
      const existing = current[groupId] || [];
      if (maxSelections === 1) {
        return { ...current, [groupId]: existing.includes(optionId) ? [] : [optionId] };
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
      setConfigurationMessage(configuration.missing.map((issue) => issue.message).join(" · ") || "Complete the required choices.");
      const first = configuration.missing[0];
      if (first) document.getElementById(first.id)?.scrollIntoView({ behavior: "smooth", block: "center" });
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
      comboId: selectedCombo?.id || null,
      comboSelections: cloneSelections(comboSelections),
      specialInstructions: specialInstructions.trim(),
    };
    setCart((current) => editingLineId ? current.map((candidate) => candidate.id === editingLineId ? line : candidate) : [...current, line]);
    setConfiguringItem(null);
    setSelectedVariantId("");
    setEditingLineId(null);
    setSavedDraft(null);
    setCartNotice(`${editingLineId ? "Updated" : "Added"} ${configuringItem.name}`);
    window.setTimeout(() => setCartNotice(""), 1800);
    window.setTimeout(() => searchInputRef.current?.focus(), 0);
  }

  function changeDeliveryAddress(value: string) {
    setDeliveryAddress(value); setValidatedAddress(null); setDeliveryValidationToken(""); setDeliveryValidatedInput(""); setDeliveryRoute(null); setAddressError(""); setSavedDraft(null);
  }

  async function validateAddress(suggestion?: AddressSuggestion) {
    const enteredAddress = suggestion?.text || deliveryAddress;
    if (suggestion) setDeliveryAddress(suggestion.text);
    setValidatingAddress(true); setAddressError(""); setAddressSuggestions([]);
    try {
      const response = await fetch("/api/ordering/address/validate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enteredAddress, placeId: suggestion?.id, sessionToken: addressSessionToken }) });
      const payload = await response.json() as { address?: ValidatedAddress; validationToken?: string; route?: DeliveryRoute | null; error?: string };
      if (!response.ok || !payload.address || !payload.validationToken) throw new Error(payload.error || "Could not validate this address.");
      setValidatedAddress(payload.address); setDeliveryValidationToken(payload.validationToken); setDeliveryValidatedInput(enteredAddress.trim().replace(/\s+/g, " ")); setDeliveryRoute(payload.route || null); setDeliveryAddress(payload.address.formattedAddress);
      setAddressSessionToken(clientId()); setSavedDraft(null);
    } catch (error) { setValidatedAddress(null); setDeliveryValidationToken(""); setDeliveryValidatedInput(""); setDeliveryRoute(null); setAddressError(error instanceof Error ? error.message : "Could not validate this address."); }
    finally { setValidatingAddress(false); }
  }

  function removeLine(lineId: string) {
    setCart((current) => current.filter((line) => line.id !== lineId));
    setSavedDraft(null);
  }

  function changeQuantity(lineId: string, delta: number) {
    setCart((current) => current
      .map((line) => line.id === lineId ? { ...line, quantity: Math.max(0, line.quantity + delta) } : line)
      .filter((line) => line.quantity > 0));
    setSavedDraft(null);
  }

  async function saveDraft() {
    if (!cart.length || savingDraft) return;
    if (serviceType === "delivery" && (!validatedAddress || !deliveryValidationToken)) {
      setCheckoutError("Validate the delivery address before reviewing this Delivery order.");
      return;
    }
    if (timingMode === "future" && !scheduledFor) {
      setCheckoutError("Choose the future pickup/delivery time before saving the order.");
      return;
    }
    setSavingDraft(true);
    setCheckoutError("");
    setSavedDraft(null);
    try {
      const response = await fetch("/api/ordering/orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          business,
          serviceType,
          timingMode,
          scheduledFor: timingMode === "future" ? new Date(scheduledFor).toISOString() : null,
          deliveryAddress: serviceType === "delivery" ? deliveryValidatedInput : undefined,
          deliveryUnit: serviceType === "delivery" ? deliveryUnit : undefined,
          deliveryValidationToken: serviceType === "delivery" ? deliveryValidationToken : undefined,
          items: cart.map((line) => ({
            itemId: line.itemId,
            variantId: line.variantId,
            quantity: line.quantity,
            modifierSelections: line.modifierSelections,
            modifierQuantities: line.modifierQuantities,
            comboId: line.comboId,
            comboSelections: line.comboSelections,
            specialInstructions: line.specialInstructions,
          })),
        }),
      });
      const payload = await response.json() as {
        order?: {
          id: string;
          display_number: string;
          total_cents: number;
          scheduled_for: string | null;
          timing_message_snapshot: string;
          kitchen_timing_label_snapshot: string;
        };
        error?: string;
      };
      if (!response.ok || !payload.order) throw new Error(payload.error || "Could not save draft order.");
      setSavedDraft({
        id: payload.order.id,
        displayNumber: payload.order.display_number,
        totalCents: Number(payload.order.total_cents),
        timingMessage: payload.order.timing_message_snapshot || "",
        kitchenTimingLabel: payload.order.kitchen_timing_label_snapshot || "",
        scheduledFor: payload.order.scheduled_for,
      });
      if (Number(payload.order.total_cents) !== subtotalCents) {
        setCheckoutError(`Menu pricing changed. Backend total is ${money(Number(payload.order.total_cents))}; review before continuing.`);
      }
    } catch (error) {
      setCheckoutError(error instanceof Error ? error.message : "Could not save draft order.");
    } finally {
      setSavingDraft(false);
    }
  }

  async function submitOrder() {
    if (!savedDraft || submittingOrder) return;
    setSubmittingOrder(true);
    setCheckoutError("");
    try {
      const response = await fetch(`/api/ordering/orders/${encodeURIComponent(savedDraft.id)}/submit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ business }),
      });
      const payload = await response.json() as {
        order?: { display_number: string; total_cents: number };
        error?: string;
      };
      if (!response.ok || !payload.order) throw new Error(payload.error || "Could not submit order.");
      setSubmittedOrder({ displayNumber: payload.order.display_number, totalCents: Number(payload.order.total_cents) });
      setCart([]);
      setSavedDraft(null);
      setScheduledFor("");
      setTimingMode("asap");
    } catch (error) {
      setCheckoutError(error instanceof Error ? error.message : "Could not submit order.");
    } finally {
      setSubmittingOrder(false);
    }
  }

  if (!session) return <main className="posLoading">Loading {business} POS…</main>;
  if (!session.authenticated && business === "Corner Deli") return <PosPinGate onAuthenticated={(employee) => setSession({ authenticated: true, session: employee })} />;
  if (!session.authenticated) return <main className="posLoading"><a href="/signin">Sign in to Corner Ops</a></main>;
  if ("businesses" in session && session.businesses?.length && !session.businesses.includes(business)) {
    return <main className="posLoading">Your account does not have access to {business}.</main>;
  }
  const posEmployee = "session" in session ? session.session as PosEmployeeSession | undefined : undefined;

  return <main className="posPage">
    <header className="posHeader posHeaderFixedBusiness">
      <div className="posBrandBlock">
        <span className="posDevBadge">DEVELOPMENT · AUTO DEPLOY OFF</span>
        <strong>{business} POS</strong>
        <small className="posSeparateNote">Separate development POS · not connected to the live application</small>
      </div>
      <nav className="posUtilityNav" aria-label={`${business} POS utilities`}>
        {posEmployee && <span className="posEmployeeName">{posEmployee.name}</span>}
        {config.utilities.map((utility) => utility === "reports"
          ? <a key={utility} href={config.reportsPath}>{utilityLabels[utility]}</a>
          : <button key={utility} type="button">{utilityLabels[utility]}</button>)}
        {business === "Corner Deli" && <a href="/pos/deli/kitchen">Kitchen</a>}
        {business === "Corner Deli" && <button type="button" onClick={() => void lockPos()}>LOCK / SWITCH EMPLOYEE</button>}
        <a href="/pos">POS Dev Home</a>
      </nav>
    </header>

    <section className="posServiceBar" aria-label="Fulfillment type and timing">
      {availableServices.map((service) => <button key={service} type="button" className={serviceType === service ? "active" : ""} onClick={() => { setServiceType(service); setSavedDraft(null); setCheckoutError(""); }}>
        <span>{serviceLabels[service].label}</span>
        {serviceLabels[service].paymentNote && <small>{serviceLabels[service].paymentNote}</small>}
      </button>)}
      <button type="button" className={`futureOrderButton ${timingMode === "asap" ? "active" : ""}`} onClick={() => { setTimingMode("asap"); setSavedDraft(null); }}>
        <span>ASAP</span>
        <small>Use current quote</small>
      </button>
      <button type="button" className={`futureOrderButton ${timingMode === "future" ? "active" : ""}`} onClick={() => { setTimingMode("future"); setSavedDraft(null); }}>
        <span>Future</span>
        <small>Choose time</small>
      </button>
      {timingMode === "future" && <input
        className="posFutureTimeInput"
        aria-label="Future order time"
        type="datetime-local"
        value={scheduledFor}
        onChange={(event) => { setScheduledFor(event.target.value); setSavedDraft(null); }}
      />}
    </section>

    {serviceType === "delivery" && <section className="posDelivery" aria-label="Customer and delivery address">
      <div className="posDeliveryHeading"><div><span>Customer / Delivery</span><h2>Delivery address</h2></div>{validatedAddress && <strong className="addressValid">VALIDATED</strong>}</div>
      <div className="posAddressEntry">
        <div className="posAddressAutocomplete">
          <label>Street address<input
            value={deliveryAddress}
            autoComplete="off"
            spellCheck={false}
            placeholder="Start typing an address"
            aria-expanded={addressSuggestions.length > 0}
            aria-controls="delivery-address-suggestions"
            onChange={(event) => changeDeliveryAddress(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") { event.preventDefault(); setActiveSuggestion((current) => Math.min(addressSuggestions.length - 1, current + 1)); }
              if (event.key === "ArrowUp") { event.preventDefault(); setActiveSuggestion((current) => Math.max(0, current - 1)); }
              if (event.key === "Escape") setAddressSuggestions([]);
              if (event.key === "Enter") { event.preventDefault(); const suggestion = addressSuggestions[activeSuggestion]; if (suggestion) void validateAddress(suggestion); else void validateAddress(); }
            }}
          /></label>
          {(addressLoading || addressSuggestions.length > 0 || (deliveryAddress.trim().length >= 2 && !addressLoading && !validatedAddress && !addressError)) && <div id="delivery-address-suggestions" className="posAddressSuggestions" role="listbox">
            {addressLoading && <div className="addressState">Finding nearby addresses…</div>}
            {!addressLoading && addressSuggestions.map((suggestion, index) => <button key={suggestion.id} type="button" role="option" aria-selected={activeSuggestion === index} className={activeSuggestion === index ? "active" : ""} onMouseDown={(event) => event.preventDefault()} onClick={() => void validateAddress(suggestion)}><strong>{suggestion.mainText}</strong><span>{suggestion.secondaryText}</span></button>)}
            {!addressLoading && !addressSuggestions.length && <div className="addressState">No addresses found.</div>}
            {addressSuggestions.length > 0 && <small>Powered by Google</small>}
          </div>}
        </div>
        <label>Apartment / unit<input value={deliveryUnit} maxLength={120} autoComplete="off" onChange={(event) => { setDeliveryUnit(event.target.value); setSavedDraft(null); }} /></label>
        <button type="button" className="validateAddressButton" disabled={validatingAddress || deliveryAddress.trim().length < 5 || Boolean(validatedAddress)} onClick={() => void validateAddress()}>{validatingAddress ? "Validating…" : validatedAddress ? "Validated" : "Validate address"}</button>
      </div>
      {validatedAddress && <p className="addressResult"><strong>{validatedAddress.formattedAddress}</strong>{deliveryRoute ? ` · ${deliveryRoute.distanceMiles.toFixed(1)} driving miles · about ${Math.max(1, Math.round(deliveryRoute.durationSeconds / 60))} min` : " · Driving distance unavailable until store origin is configured"}</p>}
      {addressError && <p className="addressError" role="alert">{addressError}</p>}
    </section>}

    {savedDraft && <div className="posSaveNotice">
      Draft #{savedDraft.displayNumber} ready for review · {money(savedDraft.totalCents)} · UNPAID
      {savedDraft.timingMessage ? ` · ${savedDraft.timingMessage}` : ""}
      {savedDraft.kitchenTimingLabel ? ` · Kitchen: ${savedDraft.kitchenTimingLabel.replace(/\n/g, " / ")}` : ""}
    </div>}
    {submittedOrder && <div className="posSaveNotice success" role="status">
      Order #{submittedOrder.displayNumber} submitted to kitchen · {money(submittedOrder.totalCents)} · UNPAID
    </div>}
    {checkoutError && <div className="posSaveNotice error">{checkoutError}</div>}
    {cartNotice && <div className="posCartToast" aria-live="polite">{cartNotice}</div>}

    <nav className="posMenuNavigation" aria-label="Menu categories">
      <div className="posPrimaryCategories">
        {primaryCategories.map((category) => <button type="button" key={category.id} className={activePrimary?.id === category.id && !menuSearch ? "active" : ""} onClick={() => { setMenuSearch(""); setPrimaryCategoryId(category.id); const children = menu.filter((child) => child.parentId === category.id); setCategoryId(category.presentationOnly ? children[0]?.id || "" : category.id); }}>{category.displayName}</button>)}
      </div>
      {subcategories.length > 0 && !menuSearch && <div className="posSubcategories" aria-label={`${activePrimary?.displayName} subcategories`}>
        {subcategories.map((category) => <button type="button" key={category.id} className={activeCategory?.id === category.id ? "active" : ""} onClick={() => setCategoryId(category.id)}>{category.displayName}</button>)}
      </div>}
    </nav>

    <section className="posWorkspace">
      <section className="posMenuPanel">
        <div className="posPanelHeading">
          <div><span>{menuSearch ? "Search results" : "Category"}</span><h1>{menuSearch ? `Results for “${menuSearch}”` : activeCategory?.displayName || "Menu"}</h1></div>
          <div className="posStatusPill">{serviceLabels[serviceType].label} · {timingMode === "asap" ? "ASAP" : "Future"}</div>
        </div>
        <label className="posMenuSearch">Search menu<input ref={searchInputRef} type="search" value={menuSearch} placeholder="Search items or sizes" onChange={(event) => setMenuSearch(event.target.value)} /></label>
        {menuLoading && <div className="posEmpty">Loading menu…</div>}
        {menuError && <div className="posEmpty error">{menuError}</div>}
        {!menuLoading && !menuError && !visibleItems.length && <div className="posEmpty">{menuSearch ? "No matching menu items." : "No active items in this category yet."}</div>}
        <div className="posItemGrid">
          {visibleItems.map((item) => {
            const availableVariants = item.variants.filter((variant) => variant.available);
            const displayPrice = availableVariants.length
              ? Math.min(...availableVariants.map((variant) => variant.basePriceCents))
              : item.basePriceCents;
            return <button key={item.id} type="button" className={`posItemButton ${item.available ? "" : "soldOut"}`} disabled={!item.available} onClick={() => openItem(item)}>
              <strong>{item.name}</strong>
              <span>{availableVariants.length > 1 ? `From ${money(displayPrice)}` : money(displayPrice)}</span>
              {!item.available && <small>SOLD OUT</small>}
            </button>;
          })}
        </div>
      </section>

      <aside className="posCart">
        <div className="posCartHeading">
          <div><span>Current order</span><h2>New {serviceLabels[serviceType].label} · {timingMode === "asap" ? "ASAP" : "Future"}</h2></div>
          <button type="button" onClick={() => { setCart([]); setSavedDraft(null); }} disabled={!cart.length}>Clear</button>
        </div>
        <div className="posCartLines">
          {!cart.length && <div className="posEmpty">Tap a menu item to start the order.</div>}
          {cart.map((line) => <article className="posCartLine" key={line.id}>
            <div className="posLineTop"><strong>{line.quantity}× {line.name}</strong><span>{money(line.unitPriceCents * line.quantity)}</span></div>
            {line.variantName && <small>Size / form: {line.variantName}</small>}
            {[...line.modifierText, ...line.comboText].map((text, index) => <small key={`${text}-${index}`}>{text}</small>)}
            {line.specialInstructions && <small>Note: {line.specialInstructions}</small>}
            <div className="posQtyControls">
              <button type="button" onClick={() => changeQuantity(line.id, -1)}>−</button>
              <span>{line.quantity}</span>
              <button type="button" onClick={() => changeQuantity(line.id, 1)}>+</button>
              <button type="button" aria-label={`Edit ${line.name}`} className="posLineAction" onClick={() => { const item = menu.flatMap((category) => category.items).find((candidate) => candidate.id === line.itemId); if (item) openItem(item, line); else setCheckoutError("This menu item changed and can no longer be edited."); }}>Edit</button>
              <button type="button" aria-label={`Remove ${line.name}`} className="posLineAction danger" onClick={() => removeLine(line.id)}>Remove</button>
            </div>
          </article>)}
        </div>
        <div className="posTotals">
          <div><span>Subtotal</span><strong>{money(subtotalCents)}</strong></div>
          <div><span>Tax</span><strong>Included/configured at checkout</strong></div>
          <div className="grand"><span>{savedDraft ? "Backend total" : "Estimated total"}</span><strong>{money(savedDraft?.totalCents ?? subtotalCents)}</strong></div>
        </div>
        <div className="posCheckoutButtons">
          <button type="button" className="primary" disabled={!cart.length || savingDraft || Boolean(savedDraft) || (timingMode === "future" && !scheduledFor)} onClick={() => void saveDraft()}>
            {savingDraft ? "Saving…" : timingMode === "future" ? "Save Future Draft / Review" : "Save ASAP Draft / Review"}
          </button>
          {savedDraft && <section className="posSubmitReview" aria-label={`Review draft ${savedDraft.displayNumber}`}>
            <strong>Review order #{savedDraft.displayNumber}</strong>
            <span>{serviceLabels[serviceType].label} · {cart.length} line{cart.length === 1 ? "" : "s"} · {money(savedDraft.totalCents)} · UNPAID</span>
            <button type="button" className="submitOrder" disabled={submittingOrder || Boolean(checkoutError)} onClick={() => void submitOrder()}>
              {submittingOrder ? "Submitting…" : "SUBMIT ORDER"}
            </button>
          </section>}
        </div>
      </aside>
    </section>

    {configuringItem && <div className="posModalBackdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setConfiguringItem(null); }}>
      <section className="posConfigModal" role="dialog" aria-modal="true" aria-label={`Configure ${configuringItem.name}`}>
        <header>
          <div><span>Configure item</span><h2>{configuringItem.name}</h2><p>{configuringItem.description}</p></div>
          <button type="button" onClick={() => setConfiguringItem(null)}>Close</button>
        </header>
        <div className="posConfigBody">
          {configuringItem.variants.length > 0 && <fieldset id="variant-choice" className={!selectedVariant ? "needsSelection" : ""}>
            <legend>Size / form<small>Required · only valid forms for this item are shown</small></legend>
            <div className="posChoiceGrid">
              {configuringItem.variants.map((variant) => <button
                key={variant.id}
                type="button"
                disabled={!variant.available}
                className={selectedVariantId === variant.id ? "selected" : ""}
                onClick={() => chooseVariant(variant)}
              >
                <strong>{variant.name}</strong>
                <span>{variant.available ? money(variant.basePriceCents) : "Unavailable"}</span>
              </button>)}
            </div>
          </fieldset>}

          {configuringItem.modifiers.map((group) => {
            const selected = modifierSelections[group.id] || [];
            const valid = selectionsValid(group, selected);
            return <fieldset id={`modifier-${group.id}`} key={group.id} className={!valid ? "needsSelection" : ""}>
              <legend>{group.prompt || group.name}<small>{group.minSelections > 0 ? "Required" : "Optional"} · choose {group.minSelections === group.maxSelections ? group.maxSelections : `${group.minSelections}-${group.maxSelections}`}</small></legend>
              <div className="posChoiceGrid">
                {group.options.map((option) => {
                  const available = variantOptionAvailable(selectedVariant, option);
                  const priceDeltaCents = variantOptionPrice(selectedVariant, option);
                  const selectedOption = selected.includes(option.id);
                  return <div className="posModifierChoice" key={option.id}><button type="button" disabled={!available} className={selectedOption ? "selected" : ""} onClick={() => toggleModifier(group, option.id)}>
                    <strong>{option.name}</strong>
                    <span>{!available
                      ? "Unavailable for this size/form"
                      : priceDeltaCents
                        ? `${priceDeltaCents > 0 ? "+" : ""}${money(priceDeltaCents)}`
                        : option.defaultSelected ? "Default" : "Included"}</span>
                  </button>{selectedOption && group.allowOptionQuantity && <div className="posModifierQty" aria-label={`${option.name} quantity`}><button type="button" onClick={() => changeModifierQuantity(option.id, -1)} aria-label={`Decrease ${option.name}`}>−</button><strong>{modifierQuantities[option.id] || 1}</strong><button type="button" onClick={() => changeModifierQuantity(option.id, 1)} aria-label={`Increase ${option.name}`}>+</button></div>}</div>;
                })}
              </div>
            </fieldset>;
          })}

          {configuringItem.combos.length > 0 && <fieldset>
            <legend>Combo options<small>Optional unless selected</small></legend>
            <div className="posChoiceGrid">
              <button type="button" className={!selectedComboId ? "selected" : ""} onClick={() => chooseCombo(null)}><strong>No combo</strong><span>Item only</span></button>
              {configuringItem.combos.map((combo) => <button key={combo.id} type="button" className={selectedComboId === combo.id ? "selected" : ""} onClick={() => chooseCombo(combo)}>
                <strong>{combo.name}</strong><span>{combo.basePriceDeltaCents ? `+${money(combo.basePriceDeltaCents)}` : "Included"}</span>
              </button>)}
            </div>
          </fieldset>}

          {selectedCombo?.groups.map((group) => {
            const selected = comboSelections[group.id] || [];
            const valid = selected.length >= group.minSelections && selected.length <= group.maxSelections;
            return <fieldset id={`combo-${group.id}`} key={group.id} className={!valid ? "needsSelection" : ""}>
              <legend>{group.prompt || group.name}<small>Required combo choice</small></legend>
              <div className="posChoiceGrid">
                {group.options.map((option) => <button key={option.id} type="button" disabled={!option.available} className={selected.includes(option.id) ? "selected" : ""} onClick={() => toggleComboOption(group.id, group.maxSelections, option.id)}>
                  <strong>{option.name}</strong><span>{option.priceDeltaCents ? `+${money(option.priceDeltaCents)}` : "Included"}</span>
                </button>)}
              </div>
            </fieldset>;
          })}
          <label className="posItemNotes">Item notes<textarea value={specialInstructions} maxLength={500} placeholder="Kitchen note (optional)" onChange={(event) => setSpecialInstructions(event.target.value)} /></label>
        </div>
        <footer>
          <div><span>Configured price</span><strong>{money(configuration.unitPriceCents)}</strong></div>
          <div className="posConfigActions">
            {(!configuration.valid || configurationMessage) && <div className="posConfigurationMissing" role="alert">{configuration.missing.map((issue) => <span key={issue.id}>{issue.message}</span>)}</div>}
            <button type="button" onClick={() => setConfiguringItem(null)}>CANCEL</button>
            <button type="button" className={`primary ${configuration.valid ? "" : "invalid"}`} aria-disabled={!configuration.valid} onClick={addConfiguredItem}>
              {editingLineId ? "UPDATE ITEM" : "ADD TO ORDER"}
            </button>
          </div>
        </footer>
      </section>
    </div>}
  </main>;
}

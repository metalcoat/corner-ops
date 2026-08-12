"use client";

import { useEffect, useMemo, useState } from "react";
import type { Business, SessionView } from "@/lib/types";
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
  const [session, setSession] = useState<SessionView | null>(null);
  const [menu, setMenu] = useState<OrderingMenuCategoryWithVariants[]>([]);
  const [menuLoading, setMenuLoading] = useState(true);
  const [menuError, setMenuError] = useState("");
  const [categoryId, setCategoryId] = useState("");
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

  useEffect(() => {
    document.documentElement.dataset.businessTheme = business;
    window.localStorage.setItem("corner-ops-business-theme", business);
    fetch("/api/auth/session", { cache: "no-store" })
      .then((response) => response.json())
      .then((payload: SessionView) => setSession(payload))
      .catch(() => setSession({ authenticated: false } as SessionView));
  }, [business]);

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
        setCategoryId((current) => current && payload.categories.some((category) => category.id === current)
          ? current
          : payload.categories[0]?.id || "");
      })
      .catch((error) => {
        if (!cancelled) setMenuError(error instanceof Error ? error.message : "Could not load menu.");
      })
      .finally(() => {
        if (!cancelled) setMenuLoading(false);
      });
    return () => { cancelled = true; };
  }, [business, session?.authenticated]);

  const activeCategory = menu.find((category) => category.id === categoryId) || menu[0];
  const subtotalCents = cart.reduce((sum, line) => sum + line.unitPriceCents * line.quantity, 0);
  const selectedCombo = configuringItem?.combos.find((combo) => combo.id === selectedComboId) || null;
  const selectedVariant = configuringItem?.variants.find((variant) => variant.id === selectedVariantId) || null;

  const configuration = useMemo(() => {
    if (!configuringItem) {
      return { valid: false, unitPriceCents: 0, modifierText: [] as string[], comboText: [] as string[] };
    }

    const variantRequired = configuringItem.variants.length > 0;
    let valid = !variantRequired || Boolean(selectedVariant);
    let unitPriceCents = selectedVariant?.basePriceCents ?? configuringItem.basePriceCents;
    const modifierText: string[] = [];
    const comboText: string[] = [];

    for (const group of configuringItem.modifiers) {
      const selected = modifierSelections[group.id] || [];
      if (!selectionsValid(group, selected)) valid = false;
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
        if (selected.length < group.minSelections || selected.length > group.maxSelections) valid = false;
        for (const option of group.options.filter((candidate) => selected.includes(candidate.id))) {
          unitPriceCents += option.priceDeltaCents;
          comboText.push(`${group.name}: ${option.name}`);
        }
      }
    }

    return { valid, unitPriceCents, modifierText, comboText };
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
    if (!configuringItem || !configuration.valid) return;
    const line: CartLine = {
      id: editingLineId || crypto.randomUUID(),
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

  if (!session) return <main className="posLoading">Loading {business} POS…</main>;
  if (!session.authenticated) return <main className="posLoading"><a href="/signin">Sign in to Corner Ops</a></main>;
  if (session.businesses?.length && !session.businesses.includes(business)) {
    return <main className="posLoading">Your account does not have access to {business}.</main>;
  }

  return <main className="posPage">
    <header className="posHeader posHeaderFixedBusiness">
      <div className="posBrandBlock">
        <span className="posDevBadge">DEVELOPMENT · AUTO DEPLOY OFF</span>
        <strong>{business} POS</strong>
        <small className="posSeparateNote">Separate development POS · not connected to the live application</small>
      </div>
      <nav className="posUtilityNav" aria-label={`${business} POS utilities`}>
        {config.utilities.map((utility) => utility === "reports"
          ? <a key={utility} href={config.reportsPath}>{utilityLabels[utility]}</a>
          : <button key={utility} type="button">{utilityLabels[utility]}</button>)}
        <a href="/pos">POS Dev Home</a>
      </nav>
    </header>

    <section className="posServiceBar" aria-label="Fulfillment type and timing">
      {availableServices.map((service) => <button key={service} type="button" className={serviceType === service ? "active" : ""} onClick={() => { setServiceType(service); setSavedDraft(null); }}>
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

    {savedDraft && <div className="posSaveNotice">
      Draft #{savedDraft.displayNumber} saved · {money(savedDraft.totalCents)}
      {savedDraft.timingMessage ? ` · ${savedDraft.timingMessage}` : ""}
      {savedDraft.kitchenTimingLabel ? ` · Kitchen: ${savedDraft.kitchenTimingLabel.replace(/\n/g, " / ")}` : ""}
    </div>}
    {checkoutError && <div className="posSaveNotice error">{checkoutError}</div>}

    <section className="posWorkspace">
      <aside className="posCategories">
        <h2>Menu</h2>
        {menu.map((category) => <button type="button" key={category.id} className={activeCategory?.id === category.id ? "active" : ""} onClick={() => setCategoryId(category.id)}>{category.name}</button>)}
      </aside>

      <section className="posMenuPanel">
        <div className="posPanelHeading">
          <div><span>Category</span><h1>{activeCategory?.name || "Menu"}</h1></div>
          <div className="posStatusPill">{serviceLabels[serviceType].label} · {timingMode === "asap" ? "ASAP" : "Future"}</div>
        </div>
        {menuLoading && <div className="posEmpty">Loading menu…</div>}
        {menuError && <div className="posEmpty error">{menuError}</div>}
        {!menuLoading && !menuError && !activeCategory?.items.length && <div className="posEmpty">No active items in this category yet.</div>}
        <div className="posItemGrid">
          {activeCategory?.items.map((item) => {
            const availableVariants = item.variants.filter((variant) => variant.available);
            const displayPrice = availableVariants.length
              ? Math.min(...availableVariants.map((variant) => variant.basePriceCents))
              : item.basePriceCents;
            return <button key={item.id} type="button" className={`posItemButton ${item.available ? "" : "soldOut"}`} disabled={!item.available} onClick={() => openItem(item)}>
              <strong>{item.name}</strong>
              <span>{availableVariants.length > 1 ? `From ${money(displayPrice)}` : money(displayPrice)}</span>
              <small>{!item.available
                ? "SOLD OUT"
                : [item.variants.length ? `${item.variants.length} sizes/forms` : "", item.modifiers.length ? "Modifiers" : "", item.combos.length ? "Combo" : ""].filter(Boolean).join(" · ") || "Quick add"}</small>
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
          <button type="button" className="primary" disabled={!cart.length || savingDraft || (timingMode === "future" && !scheduledFor)} onClick={() => void saveDraft()}>
            {savingDraft ? "Saving…" : timingMode === "future" ? "Save Future Draft / Review" : "Save ASAP Draft / Review"}
          </button>
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
          {configuringItem.variants.length > 0 && <fieldset className={!selectedVariant ? "needsSelection" : ""}>
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
            return <fieldset key={group.id} className={!valid ? "needsSelection" : ""}>
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
            return <fieldset key={group.id} className={!valid ? "needsSelection" : ""}>
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
          <button type="button" className="primary" disabled={!configuration.valid} onClick={addConfiguredItem}>
            {configuration.valid ? editingLineId ? "Update item" : "Add to order" : configuringItem.variants.length && !selectedVariant ? "Choose size / form" : "Complete required choices"}
          </button>
        </footer>
      </section>
    </div>}
  </main>;
}

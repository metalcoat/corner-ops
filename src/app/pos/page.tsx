"use client";

import { useEffect, useMemo, useState } from "react";
import type { Business, SessionView } from "@/lib/types";
import type {
  OrderingComboView,
  OrderingMenuCategoryView,
  OrderingMenuItemView,
  OrderingModifierGroupView,
} from "@/lib/ordering-menu";
import "./pos.css";

type ServiceType = "pickup" | "delivery" | "no_contact_delivery" | "dine_in" | "curbside";

type CartLine = {
  id: string;
  itemId: string;
  name: string;
  quantity: number;
  unitPriceCents: number;
  modifierText: string[];
  comboText: string[];
};

type MenuPayload = {
  business: Business;
  categories: OrderingMenuCategoryView[];
};

const businessStorageKey = "corner-ops-business-theme";

const serviceTypes: Array<{ value: ServiceType; label: string; paymentNote?: string }> = [
  { value: "pickup", label: "Pickup" },
  { value: "delivery", label: "Delivery" },
  { value: "no_contact_delivery", label: "No-contact", paymentNote: "Prepay online" },
  { value: "dine_in", label: "Eat in" },
  { value: "curbside", label: "Curbside", paymentNote: "Prepay online" },
];

function money(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

function initialModifierSelections(item: OrderingMenuItemView): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const group of item.modifiers) {
    result[group.id] = group.options.filter((option) => option.defaultSelected).map((option) => option.id);
  }
  return result;
}

function selectionsValid(group: OrderingModifierGroupView, selections: string[]): boolean {
  const count = selections.length;
  return count >= group.minSelections && count <= group.maxSelections;
}

export default function PosPage() {
  const [session, setSession] = useState<SessionView | null>(null);
  const [business, setBusiness] = useState<Business>("Corner Deli");
  const [menu, setMenu] = useState<OrderingMenuCategoryView[]>([]);
  const [menuLoading, setMenuLoading] = useState(true);
  const [menuError, setMenuError] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [serviceType, setServiceType] = useState<ServiceType>("pickup");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [configuringItem, setConfiguringItem] = useState<OrderingMenuItemView | null>(null);
  const [modifierSelections, setModifierSelections] = useState<Record<string, string[]>>({});
  const [selectedComboId, setSelectedComboId] = useState("");
  const [comboSelections, setComboSelections] = useState<Record<string, string[]>>({});

  useEffect(() => {
    const saved = window.localStorage.getItem(businessStorageKey);
    if (saved === "Corner Deli" || saved === "Tiki") setBusiness(saved);
    fetch("/api/auth/session", { cache: "no-store" })
      .then((response) => response.json())
      .then((payload: SessionView) => setSession(payload))
      .catch(() => setSession({ authenticated: false } as SessionView));
  }, []);

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

  const configuration = useMemo(() => {
    if (!configuringItem) return { valid: false, unitPriceCents: 0, modifierText: [] as string[], comboText: [] as string[] };
    let unitPriceCents = configuringItem.basePriceCents;
    const modifierText: string[] = [];
    const comboText: string[] = [];
    let valid = true;

    for (const group of configuringItem.modifiers) {
      const selected = modifierSelections[group.id] || [];
      if (!selectionsValid(group, selected)) valid = false;
      for (const option of group.options) {
        const chosen = selected.includes(option.id);
        if (chosen) {
          unitPriceCents += option.priceDeltaCents;
          if (!option.defaultSelected || option.priceDeltaCents !== 0) modifierText.push(`${group.name}: ${option.name}`);
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
  }, [configuringItem, modifierSelections, selectedCombo, comboSelections]);

  function chooseBusiness(next: Business) {
    setBusiness(next);
    setCart([]);
    window.localStorage.setItem(businessStorageKey, next);
    document.documentElement.dataset.businessTheme = next;
  }

  function openItem(item: OrderingMenuItemView) {
    if (!item.available) return;
    setConfiguringItem(item);
    setModifierSelections(initialModifierSelections(item));
    setSelectedComboId("");
    setComboSelections({});
  }

  function toggleModifier(group: OrderingModifierGroupView, optionId: string) {
    setModifierSelections((current) => {
      const existing = current[group.id] || [];
      if (group.maxSelections === 1) return { ...current, [group.id]: existing.includes(optionId) ? [] : [optionId] };
      return {
        ...current,
        [group.id]: existing.includes(optionId)
          ? existing.filter((id) => id !== optionId)
          : [...existing, optionId].slice(0, group.maxSelections),
      };
    });
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
      if (maxSelections === 1) return { ...current, [groupId]: existing.includes(optionId) ? [] : [optionId] };
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
    setCart((current) => [...current, {
      id: crypto.randomUUID(),
      itemId: configuringItem.id,
      name: configuringItem.name,
      quantity: 1,
      unitPriceCents: configuration.unitPriceCents,
      modifierText: configuration.modifierText,
      comboText: configuration.comboText,
    }]);
    setConfiguringItem(null);
  }

  function changeQuantity(lineId: string, delta: number) {
    setCart((current) => current
      .map((line) => line.id === lineId ? { ...line, quantity: Math.max(0, line.quantity + delta) } : line)
      .filter((line) => line.quantity > 0));
  }

  if (!session) return <main className="posLoading">Loading POS…</main>;
  if (!session.authenticated) return <main className="posLoading"><a href="/signin">Sign in to Corner Ops</a></main>;

  const allowedBusinesses = session.businesses?.length ? session.businesses : (["Corner Deli", "Tiki"] as Business[]);

  return <main className="posPage">
    <header className="posHeader">
      <div className="posBrandBlock">
        <span className="posDevBadge">DEVELOPMENT · AUTO DEPLOY OFF</span>
        <strong>{business} POS</strong>
      </div>
      <div className="posBusinessSwitch" aria-label="Business">
        {allowedBusinesses.map((name) => <button key={name} type="button" className={business === name ? "active" : ""} onClick={() => chooseBusiness(name)}>{name}</button>)}
      </div>
      <nav className="posUtilityNav" aria-label="POS utilities">
        <button type="button">Orders</button>
        <button type="button">Cash Drawer</button>
        <button type="button">Drivers</button>
        <button type="button">Inventory</button>
        <button type="button">Manager</button>
        <a href="/ops/people">Exit POS</a>
      </nav>
    </header>

    <section className="posServiceBar" aria-label="Fulfillment type">
      {serviceTypes.map((service) => <button key={service.value} type="button" className={serviceType === service.value ? "active" : ""} onClick={() => setServiceType(service.value)}>
        <span>{service.label}</span>
        {service.paymentNote && <small>{service.paymentNote}</small>}
      </button>)}
      <button type="button" className="futureOrderButton">Future Order</button>
    </section>

    <section className="posWorkspace">
      <aside className="posCategories">
        <h2>Menu</h2>
        {menu.map((category) => <button type="button" key={category.id} className={activeCategory?.id === category.id ? "active" : ""} onClick={() => setCategoryId(category.id)}>{category.name}</button>)}
      </aside>

      <section className="posMenuPanel">
        <div className="posPanelHeading">
          <div><span>Category</span><h1>{activeCategory?.name || "Menu"}</h1></div>
          <div className="posStatusPill">{serviceTypes.find((service) => service.value === serviceType)?.label}</div>
        </div>
        {menuLoading && <div className="posEmpty">Loading menu…</div>}
        {menuError && <div className="posEmpty error">{menuError}</div>}
        {!menuLoading && !menuError && !activeCategory?.items.length && <div className="posEmpty">No active items in this category yet.</div>}
        <div className="posItemGrid">
          {activeCategory?.items.map((item) => <button key={item.id} type="button" className={`posItemButton ${item.available ? "" : "soldOut"}`} disabled={!item.available} onClick={() => openItem(item)}>
            <strong>{item.name}</strong>
            <span>{money(item.basePriceCents)}</span>
            <small>{!item.available ? "SOLD OUT" : [item.modifiers.length ? "Modifiers" : "", item.combos.length ? "Combo" : ""].filter(Boolean).join(" · ") || "Quick add"}</small>
          </button>)}
        </div>
      </section>

      <aside className="posCart">
        <div className="posCartHeading"><div><span>Current order</span><h2>New {serviceTypes.find((service) => service.value === serviceType)?.label}</h2></div><button type="button" onClick={() => setCart([])} disabled={!cart.length}>Clear</button></div>
        <div className="posCartLines">
          {!cart.length && <div className="posEmpty">Tap a menu item to start the order.</div>}
          {cart.map((line) => <article className="posCartLine" key={line.id}>
            <div className="posLineTop"><strong>{line.quantity}× {line.name}</strong><span>{money(line.unitPriceCents * line.quantity)}</span></div>
            {[...line.modifierText, ...line.comboText].map((text) => <small key={text}>{text}</small>)}
            <div className="posQtyControls"><button type="button" onClick={() => changeQuantity(line.id, -1)}>−</button><span>{line.quantity}</span><button type="button" onClick={() => changeQuantity(line.id, 1)}>+</button></div>
          </article>)}
        </div>
        <div className="posTotals">
          <div><span>Subtotal</span><strong>{money(subtotalCents)}</strong></div>
          <div><span>Tax</span><strong>Calculated at checkout</strong></div>
          <div className="grand"><span>Current total</span><strong>{money(subtotalCents)}</strong></div>
        </div>
        <div className="posCheckoutButtons">
          <button type="button" className="secondary">Hold</button>
          <button type="button" className="primary" disabled={!cart.length}>Review & Pay</button>
        </div>
      </aside>
    </section>

    {configuringItem && <div className="posModalBackdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setConfiguringItem(null); }}>
      <section className="posConfigModal" role="dialog" aria-modal="true" aria-label={`Configure ${configuringItem.name}`}>
        <header><div><span>Configure item</span><h2>{configuringItem.name}</h2><p>{configuringItem.description}</p></div><button type="button" onClick={() => setConfiguringItem(null)}>Close</button></header>
        <div className="posConfigBody">
          {configuringItem.modifiers.map((group) => {
            const selected = modifierSelections[group.id] || [];
            const valid = selectionsValid(group, selected);
            return <fieldset key={group.id} className={!valid ? "needsSelection" : ""}>
              <legend>{group.prompt || group.name}<small>{group.minSelections > 0 ? "Required" : "Optional"} · choose {group.minSelections === group.maxSelections ? group.maxSelections : `${group.minSelections}-${group.maxSelections}`}</small></legend>
              <div className="posChoiceGrid">
                {group.options.map((option) => <button key={option.id} type="button" disabled={!option.available} className={selected.includes(option.id) ? "selected" : ""} onClick={() => toggleModifier(group, option.id)}>
                  <strong>{option.name}</strong><span>{option.priceDeltaCents ? `${option.priceDeltaCents > 0 ? "+" : ""}${money(option.priceDeltaCents)}` : option.defaultSelected ? "Default" : "Included"}</span>
                </button>)}
              </div>
            </fieldset>;
          })}

          {configuringItem.combos.length > 0 && <fieldset>
            <legend>Combo options<small>Optional unless selected</small></legend>
            <div className="posChoiceGrid">
              <button type="button" className={!selectedComboId ? "selected" : ""} onClick={() => chooseCombo(null)}><strong>No combo</strong><span>Item only</span></button>
              {configuringItem.combos.map((combo) => <button key={combo.id} type="button" className={selectedComboId === combo.id ? "selected" : ""} onClick={() => chooseCombo(combo)}><strong>{combo.name}</strong><span>{combo.basePriceDeltaCents ? `+${money(combo.basePriceDeltaCents)}` : "Included"}</span></button>)}
            </div>
          </fieldset>}

          {selectedCombo?.groups.map((group) => {
            const selected = comboSelections[group.id] || [];
            const valid = selected.length >= group.minSelections && selected.length <= group.maxSelections;
            return <fieldset key={group.id} className={!valid ? "needsSelection" : ""}>
              <legend>{group.prompt || group.name}<small>Required combo choice</small></legend>
              <div className="posChoiceGrid">
                {group.options.map((option) => <button key={option.id} type="button" disabled={!option.available} className={selected.includes(option.id) ? "selected" : ""} onClick={() => toggleComboOption(group.id, group.maxSelections, option.id)}><strong>{option.name}</strong><span>{option.priceDeltaCents ? `+${money(option.priceDeltaCents)}` : "Included"}</span></button>)}
              </div>
            </fieldset>;
          })}
        </div>
        <footer><div><span>Configured price</span><strong>{money(configuration.unitPriceCents)}</strong></div><button type="button" className="primary" disabled={!configuration.valid} onClick={addConfiguredItem}>{configuration.valid ? "Add to order" : "Complete required choices"}</button></footer>
      </section>
    </div>}
  </main>;
}

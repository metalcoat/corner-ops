"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import PizzaToppingSelector from "@/components/pizza-topping-selector";
import {
  formatPizzaTopping,
  pizzaToppingPriceCents,
  type PizzaToppingSelection,
} from "@/lib/ordering-pizza-toppings";
import {
  formatModifierIntensity,
  supportsSubModifierIntensity,
  type ModifierIntensity,
} from "@/lib/ordering-modifier-intensity";

type Option = {
  id: string;
  name: string;
  priceDeltaCents: number;
  available: boolean;
  defaultSelected: boolean;
};
type Group = {
  id: string;
  name: string;
  prompt: string;
  minSelections: number;
  maxSelections: number;
  presentationBehavior: "standard" | "pizza_topping";
  supportsIntensity?: boolean;
  presentationContext?: "ordinary" | "combo_trigger" | "dependent";
  parentGroupId?: string | null;
  parentOptionIds?: string[];
  options: Option[];
};
type Variant = {
  id: string;
  name: string;
  basePriceCents: number;
  defaultVariant: boolean;
  available: boolean;
  modifierPrices: Array<{
    optionId: string;
    priceDeltaCents: number;
    available: boolean;
  }>;
};
type Item = {
  id: string;
  displayName: string;
  description: string;
  basePriceCents: number;
  available: boolean;
  imageUrl: string | null;
  imageAlt: string;
  variants: Variant[];
  modifiers: Group[];
  combos: Array<{
    id: string;
    name: string;
    prompt: string;
    basePriceDeltaCents: number;
    groups: Array<{
      id: string;
      name: string;
      prompt: string;
      minSelections: number;
      maxSelections: number;
      options: Array<{
        id: string;
        name: string;
        priceDeltaCents: number;
        available: boolean;
      }>;
    }>;
  }>;
};
type Category = { id: string; displayName: string; items: Item[] };
type Catalog = {
  availability: {
    open: boolean;
    orderable: boolean;
    reason: string;
    nextAvailableAt: string | null;
    timezone: string;
  };
  categories: Category[];
  featuredItems: Item[];
  promotions: string[];
  delivery: {
    enabled: boolean;
    minimumOrderCents: number;
    maxDistanceMiles: number | null;
    feeBands: Array<{
      minMilesExclusive: number;
      maxMilesInclusive: number;
      feeCents: number;
    }>;
  };
  customer: {
    authenticated: boolean;
    loyaltyAvailableAfterSignIn: boolean;
    giftCardsAcceptedAtPayment: boolean;
  };
  checkout: { paymentEnabled: boolean };
};
type CartLine = {
  key: string;
  item: Item;
  variantId: string | null;
  quantity: number;
  modifierSelections: Record<string, string[]>;
  modifierDeclines: string[];
  modifierAmounts: Record<string, ModifierIntensity>;
  pizzaToppings: PizzaToppingSelection[];
  comboId: string | null;
  comboSelections: Record<string, string[]>;
  specialInstructions: string;
};
const money = (c: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    c / 100,
  );
async function failure(response: Response) {
  const body = await response.json().catch(() => ({}));
  return body.error || "Something went wrong.";
}
function cartDetails(line: CartLine) {
  const details: string[] = [];
  const variant = line.item.variants.find(
    (value) => value.id === line.variantId,
  )?.name;
  if (variant) details.push(variant);
  const selectedIds = new Set(Object.values(line.modifierSelections).flat());
  for (const group of line.item.modifiers) {
    if (group.presentationBehavior === "pizza_topping") continue;
    const names = group.options
      .filter(
        (option) =>
          selectedIds.has(option.id) &&
          (!option.defaultSelected ||
            (line.modifierAmounts[option.id] || "normal") !== "normal"),
      )
      .map((option) =>
        formatModifierIntensity(
          option.name,
          line.modifierAmounts[option.id] || "normal",
        ),
      );
    if (names.length) details.push(`${group.name}: ${names.join(", ")}`);
  }
  for (const topping of line.pizzaToppings) {
    const option = line.item.modifiers
      .flatMap((group) => group.options)
      .find((value) => value.id === topping.modifierOptionId);
    if (option)
      details.push(
        formatPizzaTopping(option.name, topping.portion, topping.amount),
      );
  }
  const combo = line.item.combos.find((value) => value.id === line.comboId);
  if (combo) {
    details.push(combo.name);
    const comboIds = new Set(Object.values(line.comboSelections).flat());
    for (const group of combo.groups) {
      const names = group.options
        .filter((option) => comboIds.has(option.id))
        .map((option) => option.name);
      if (names.length) details.push(`${group.name}: ${names.join(", ")}`);
    }
  }
  if (line.specialInstructions.trim())
    details.push(`Note: ${line.specialInstructions.trim()}`);
  return details;
}

export default function CustomerOrder() {
  const [serviceType, setServiceType] = useState<"pickup" | "delivery">(
      "pickup",
    ),
    [catalog, setCatalog] = useState<Catalog | null>(null),
    [loading, setLoading] = useState(true),
    [message, setMessage] = useState(""),
    [query, setQuery] = useState(""),
    [active, setActive] = useState<Item | null>(null),
    [cart, setCart] = useState<CartLine[]>([]),
    [timing, setTiming] = useState<"asap" | "future">("asap"),
    [date, setDate] = useState(""),
    [slots, setSlots] = useState<string[]>([]),
    [scheduledFor, setScheduledFor] = useState(""),
    [review, setReview] = useState<any>(null),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    setLoading(true);
    fetch(`/api/customer/catalog?serviceType=${serviceType}`, {
      cache: "no-store",
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(await failure(r));
        return r.json();
      })
      .then(setCatalog)
      .catch((e) => setMessage(e.message))
      .finally(() => setLoading(false));
  }, [serviceType]);
  useEffect(() => {
    if (timing !== "future" || !date) {
      setSlots([]);
      return;
    }
    fetch(
      `/api/customer/availability?serviceType=${serviceType}&date=${date}`,
      { cache: "no-store" },
    )
      .then((r) => r.json())
      .then((body) => setSlots(body.slots || []))
      .catch(() => setSlots([]));
  }, [date, serviceType, timing]);
  const visible = useMemo(
    () =>
      catalog?.categories
        .map((category) => ({
          ...category,
          items: category.items.filter(
            (item) =>
              !query.trim() ||
              `${item.displayName} ${item.description}`
                .toLowerCase()
                .includes(query.toLowerCase()),
          ),
        }))
        .filter((category) => category.items.length) || [],
    [catalog, query],
  );
  const populatedCategories =
    catalog?.categories.filter((category) => category.items.length) || [];
  const featuredItems = catalog?.featuredItems || [];
  const estimated = cart.reduce((sum, line) => {
    const variant = line.item.variants.find((v) => v.id === line.variantId),
      mods = line.item.modifiers
        .flatMap((g) => g.options)
        .filter((o) =>
          Object.values(line.modifierSelections).flat().includes(o.id),
        )
        .reduce((s, o) => s + o.priceDeltaCents, 0),
      toppings = line.pizzaToppings.reduce((s, topping) => {
        const option = line.item.modifiers
          .flatMap((g) => g.options)
          .find((o) => o.id === topping.modifierOptionId);
        if (!option) return s;
        const base =
          variant?.modifierPrices.find((price) => price.optionId === option.id)
            ?.priceDeltaCents ?? option.priceDeltaCents;
        return (
          s + pizzaToppingPriceCents(base, topping.portion, topping.amount)
        );
      }, 0),
      combo = line.item.combos.find((c) => c.id === line.comboId);
    return (
      sum +
      line.quantity *
        ((variant?.basePriceCents ?? line.item.basePriceCents) +
          mods +
          toppings +
          (combo?.basePriceDeltaCents || 0))
    );
  }, 0);
  function add(line: Omit<CartLine, "key">) {
    setCart((rows) => [...rows, { ...line, key: crypto.randomUUID() }]);
    setActive(null);
    setReview(null);
  }
  async function price() {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/customer/cart", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          serviceType,
          timingMode: timing,
          scheduledFor,
          items: cart.map((line) => ({
            itemId: line.item.id,
            variantId: line.variantId,
            quantity: line.quantity,
            modifierSelections: line.modifierSelections,
            modifierDeclines: line.modifierDeclines,
            modifierAmounts: line.modifierAmounts,
            pizzaToppings: line.pizzaToppings,
            comboId: line.comboId,
            comboSelections: line.comboSelections,
            specialInstructions: line.specialInstructions,
          })),
        }),
      });
      if (!response.ok) throw new Error(await failure(response));
      setReview((await response.json()).cart);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Could not price the order.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="customerOrder">
      <header className="orderHero">
        <a className="orderBrand" href="/order">
          Corner Deli <span>Online ordering preview</span>
        </a>
        <button
          className="cartJump"
          onClick={() =>
            document
              .querySelector(".orderCart")
              ?.scrollIntoView({ behavior: "smooth" })
          }
        >
          Cart · {cart.length} · {money(estimated)}
        </button>
      </header>
      <section className="orderIntro">
        <div>
          <p className="eyebrow">Made your way</p>
          <h1>What sounds good?</h1>
          <p>
            Browse the full menu anytime. Prices and choices come directly from
            the same system used in-store.
          </p>
        </div>
        <div className="servicePicker" aria-label="Fulfillment type">
          <button
            className={serviceType === "pickup" ? "selected" : ""}
            onClick={() => setServiceType("pickup")}
          >
            Pickup
          </button>
          <button
            disabled={!catalog?.delivery.enabled}
            className={serviceType === "delivery" ? "selected" : ""}
            onClick={() => setServiceType("delivery")}
          >
            Delivery
          </button>
        </div>
      </section>
      {catalog && !catalog.availability.orderable && (
        <aside className="closedNotice">
          <strong>We’re not taking ASAP {serviceType} orders right now.</strong>
          <span>
            {catalog.availability.reason} You can still browse and choose an
            available future time.
          </span>
        </aside>
      )}
      {catalog?.promotions.length ? (
        <div className="promotions">
          {catalog.promotions.map((label) => (
            <span key={label}>✦ {label}</span>
          ))}
        </div>
      ) : null}
      {catalog && (
        <nav className="categoryNav" aria-label="Menu categories">
          {featuredItems.length > 0 && (
            <button
              onClick={() =>
                document
                  .getElementById("featured-items")
                  ?.scrollIntoView({ behavior: "smooth" })
              }
            >
              Featured
            </button>
          )}
          {populatedCategories.map((category) => (
            <button
              key={category.id}
              onClick={() =>
                document
                  .getElementById(`category-${category.id}`)
                  ?.scrollIntoView({ behavior: "smooth" })
              }
            >
              {category.displayName}
            </button>
          ))}
        </nav>
      )}
      <div className="orderLayout">
        <section className="menu">
          <div className="menuTools">
            <input
              aria-label="Search menu"
              placeholder="Search sandwiches, pizza, sides…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {!query.trim() && featuredItems.length > 0 && (
            <section className="featuredItems" id="featured-items">
              <p className="eyebrow">Featured</p>
              <h2>Popular right now</h2>
              <div className="featuredGrid">
                {featuredItems.map((item) => (
                  <button
                    className="featuredItem"
                    key={item.id}
                    disabled={!item.available}
                    onClick={() => setActive(item)}
                  >
                    {item.imageUrl && (
                      <img src={item.imageUrl} alt={item.imageAlt} />
                    )}
                    <span>
                      <strong>{item.displayName}</strong>
                      <em>
                        From{" "}
                        {money(
                          Math.min(
                            item.basePriceCents,
                            ...item.variants
                              .filter((variant) => variant.available)
                              .map((variant) => variant.basePriceCents),
                          ),
                        )}
                      </em>
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )}
          {loading ? (
            <p className="loading">Loading today’s menu…</p>
          ) : (
            visible.map((category) => (
              <section
                className="menuCategory"
                id={`category-${category.id}`}
                key={category.id}
              >
                <h2>{category.displayName}</h2>
                <div className="itemGrid">
                  {category.items.map((item) => (
                    <button
                      className="menuItem"
                      key={item.id}
                      disabled={!item.available}
                      onClick={() => setActive(item)}
                    >
                      {item.imageUrl && (
                        <img src={item.imageUrl} alt={item.imageAlt} />
                      )}
                      <span className="itemCopy">
                        <strong>{item.displayName}</strong>
                        {item.description && <small>{item.description}</small>}
                        <em>
                          {item.available
                            ? `From ${money(Math.min(item.basePriceCents, ...item.variants.filter((v) => v.available).map((v) => v.basePriceCents)))}`
                            : "Unavailable"}
                        </em>
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            ))
          )}
        </section>
        <aside className="orderCart">
          <h2>Your order</h2>
          {!cart.length ? (
            <p className="empty">Your cart is ready when you are.</p>
          ) : (
            cart.map((line) => (
              <div className="cartLine" key={line.key}>
                <div>
                  <strong>
                    {line.quantity}× {line.item.displayName}
                  </strong>
                  {cartDetails(line).map((detail, index) => (
                    <small key={`${line.key}-${index}`}>{detail}</small>
                  ))}
                </div>
                <button
                  aria-label={`Remove ${line.item.displayName}`}
                  onClick={() => {
                    setCart((rows) => rows.filter((r) => r.key !== line.key));
                    setReview(null);
                  }}
                >
                  Remove
                </button>
              </div>
            ))
          )}
          <div className="cartEstimate">
            <span>Estimated menu subtotal</span>
            <strong>{money(estimated)}</strong>
          </div>
          <fieldset>
            <legend>When?</legend>
            <label>
              <input
                type="radio"
                checked={timing === "asap"}
                onChange={() => setTiming("asap")}
              />{" "}
              ASAP
            </label>
            <label>
              <input
                type="radio"
                checked={timing === "future"}
                onChange={() => setTiming("future")}
              />{" "}
              Future
            </label>
            {timing === "future" && (
              <>
                <input
                  aria-label="Future order date"
                  type="date"
                  value={date}
                  min={new Date().toISOString().slice(0, 10)}
                  onChange={(e) => {
                    setDate(e.target.value);
                    setScheduledFor("");
                  }}
                />
                <select
                  aria-label="Future order time"
                  value={scheduledFor}
                  onChange={(e) => setScheduledFor(e.target.value)}
                >
                  <option value="">Choose a time</option>
                  {slots.map((slot) => (
                    <option key={slot} value={slot}>
                      {new Date(slot).toLocaleString([], {
                        weekday: "short",
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </option>
                  ))}
                </select>
                {date && !slots.length && (
                  <small>No available times on this date.</small>
                )}
              </>
            )}
          </fieldset>
          {serviceType === "delivery" && catalog && (
            <p className="deliveryNote">
              {money(catalog.delivery.minimumOrderCents)} merchandise minimum ·
              fees based on distance · up to {catalog.delivery.maxDistanceMiles}{" "}
              miles. Address validation comes at checkout.
            </p>
          )}
          <button
            className="reviewButton"
            disabled={
              !cart.length ||
              busy ||
              (timing === "future" && !scheduledFor) ||
              (!catalog?.availability.orderable && timing === "asap")
            }
            onClick={price}
          >
            {busy ? "Checking…" : "Review authoritative total"}
          </button>
          {message && (
            <p className="orderError" role="alert">
              {message}
            </p>
          )}
          {review && (
            <div className="serverReview">
              <p>Verified by Corner Ops</p>
              {review.lines.map((line: any, index: number) => (
                <span key={index}>
                  {line.quantity}× {line.name}
                  <b>{money(line.lineTotalCents)}</b>
                </span>
              ))}
              {review.promotions.map((promo: any, index: number) => (
                <span className="discount" key={index}>
                  {promo.label}
                  <b>−{money(Number(promo.discount_cents))}</b>
                </span>
              ))}
              <span className="total">
                Current total<b>{money(review.totalCents)}</b>
              </span>
              <small>{review.timingMessage}</small>
              {review.delivery && (
                <small>
                  Delivery fee is added after the address and distance are
                  validated.
                </small>
              )}
              <div className="notLive">
                Checkout and payments aren’t live yet. This preview won’t send
                an order to the kitchen.
              </div>
            </div>
          )}
          <div className="tenderNote">
            <span>Loyalty</span>
            <small>
              Secure customer sign-in will establish the loyalty account on the
              server.
            </small>
            <span>Gift cards</span>
            <small>
              Gift card tender is reserved for the payment step; card numbers
              never change menu pricing.
            </small>
          </div>
        </aside>
      </div>
      {active && (
        <ItemDialog item={active} onClose={() => setActive(null)} onAdd={add} />
      )}
    </main>
  );
}

function ItemDialog({
  item,
  onClose,
  onAdd,
}: {
  item: Item;
  onClose: () => void;
  onAdd: (line: Omit<CartLine, "key">) => void;
}) {
  const availableVariants = item.variants.filter((v) => v.available),
    initial =
      availableVariants.find((v) => v.defaultVariant)?.id ||
      availableVariants[0]?.id ||
      null,
    [variantId, setVariantId] = useState<string | null>(initial),
    [selected, setSelected] = useState<Record<string, string[]>>(() =>
      Object.fromEntries(
        item.modifiers
          .filter((g) => g.presentationBehavior !== "pizza_topping")
          .map((g) => [
            g.id,
            g.options
              .filter((o) => o.available && o.defaultSelected)
              .map((o) => o.id),
          ]),
      ),
    ),
    [pizzaToppings, setPizzaToppings] = useState<PizzaToppingSelection[]>([]),
    [comboId, setComboId] = useState<string | null>(null),
    [comboSelections, setComboSelections] = useState<Record<string, string[]>>(
      {},
    ),
    [modifierAmounts, setModifierAmounts] = useState<
      Record<string, ModifierIntensity>
    >({}),
    [intensityChoice, setIntensityChoice] = useState<{
      group: Group;
      option: Option;
    } | null>(null),
    [quantity, setQuantity] = useState(1),
    [notes, setNotes] = useState("");
  const holdTimer = useRef<number | null>(null),
    held = useRef(false);
  const visibleModifiers = item.modifiers.filter(
    (group) =>
      group.presentationContext !== "dependent" ||
      !group.parentGroupId ||
      (selected[group.parentGroupId] || []).some((optionId) =>
        (group.parentOptionIds || []).includes(optionId),
      ),
  );
  const toggle = (group: Group, id: string) =>
    setSelected((current) => {
      const values = current[group.id] || [],
        next = values.includes(id)
          ? values.filter((v) => v !== id)
          : group.maxSelections === 1
            ? [id]
            : values.length < group.maxSelections
              ? [...values, id]
              : values;
      return { ...current, [group.id]: next };
    });
  const beginIntensityHold = (group: Group, option: Option) => {
    if (
      !supportsSubModifierIntensity(
        Boolean(group.supportsIntensity),
        option.name,
      )
    )
      return;
    held.current = false;
    holdTimer.current = window.setTimeout(() => {
      held.current = true;
      setSelected((current) => ({
        ...current,
        [group.id]: (current[group.id] || []).includes(option.id)
          ? current[group.id]
          : group.maxSelections === 1
            ? [option.id]
            : [...(current[group.id] || []), option.id].slice(
                0,
                group.maxSelections,
              ),
      }));
      setIntensityChoice({ group, option });
    }, 450);
  };
  const endIntensityHold = () => {
    if (holdTimer.current !== null) window.clearTimeout(holdTimer.current);
    holdTimer.current = null;
  };
  const chooseIntensity = (amount: ModifierIntensity) => {
    if (!intensityChoice) return;
    setModifierAmounts((current) => ({
      ...current,
      [intensityChoice.option.id]: amount,
    }));
    setIntensityChoice(null);
  };
  const valid =
    visibleModifiers
      .filter((g) => g.presentationBehavior !== "pizza_topping")
      .every(
        (g) =>
          (selected[g.id]?.length || 0) >= g.minSelections &&
          (selected[g.id]?.length || 0) <= g.maxSelections,
      ) &&
    (!availableVariants.length || variantId) &&
    (!comboId ||
      item.combos
        .find((c) => c.id === comboId)!
        .groups.every(
          (g) => (comboSelections[g.id]?.length || 0) >= g.minSelections,
        ));
  return (
    <div
      className="dialogBackdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        className="itemDialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="item-title"
      >
        <button className="dialogClose" onClick={onClose}>
          ×
        </button>
        <h2 id="item-title">{item.displayName}</h2>
        <p>{item.description}</p>
        {availableVariants.length > 1 && (
          <fieldset>
            <legend>Choose a size</legend>
            {availableVariants.map((v) => (
              <label key={v.id}>
                <input
                  type="radio"
                  checked={variantId === v.id}
                  onChange={() => setVariantId(v.id)}
                />
                <span>{v.name}</span>
                <b>{money(v.basePriceCents)}</b>
              </label>
            ))}
          </fieldset>
        )}
        {visibleModifiers.map((group) =>
          group.presentationBehavior === "pizza_topping" ? (
            <PizzaToppingSelector
              key={group.id}
              group={group}
              variant={item.variants.find((v) => v.id === variantId) || null}
              selections={pizzaToppings}
              onChange={setPizzaToppings}
              interaction="portion_first"
            />
          ) : (
            <fieldset key={group.id}>
              <legend>
                {group.prompt || group.name}{" "}
                {group.minSelections > 0 && <em>Required</em>}
              </legend>
              {group.options
                .filter((o) => o.available)
                .map((option) => {
                  const isSelected = (selected[group.id] || []).includes(
                    option.id,
                  );
                  const supportsIntensity = supportsSubModifierIntensity(
                    Boolean(group.supportsIntensity),
                    option.name,
                  );
                  return (
                    <div className="customerModifierChoice" key={option.id}>
                      <button
                        type="button"
                        className={isSelected ? "selected" : ""}
                        aria-pressed={isSelected}
                        onPointerDown={() => beginIntensityHold(group, option)}
                        onPointerUp={endIntensityHold}
                        onPointerCancel={endIntensityHold}
                        onPointerLeave={endIntensityHold}
                        onContextMenu={(event) => {
                          if (!supportsIntensity) return;
                          event.preventDefault();
                          setIntensityChoice({ group, option });
                        }}
                        onClick={() => {
                          if (held.current) {
                            held.current = false;
                            return;
                          }
                          toggle(group, option.id);
                        }}
                      >
                        <span>{isSelected ? "✓" : ""}</span>
                        <strong>{option.name}</strong>
                        <b>
                          {option.priceDeltaCents
                            ? `+${money(option.priceDeltaCents)}`
                            : ""}
                        </b>
                      </button>
                      {isSelected && supportsIntensity && (
                        <button
                          type="button"
                          className="customerAmountButton"
                          aria-label={`Change ${option.name} amount, currently ${modifierAmounts[option.id] || "normal"}`}
                          onClick={() => setIntensityChoice({ group, option })}
                        >
                          {(modifierAmounts[option.id] || "normal").toUpperCase()} ▾
                        </button>
                      )}
                    </div>
                  );
                })}
            </fieldset>
          ),
        )}
        {intensityChoice && (
          <div
            className="customerIntensityPopover"
            role="group"
            aria-label={`${intensityChoice.option.name} amount`}
          >
            <strong>{intensityChoice.option.name}</strong>
            <small>Choose how much</small>
            <div>
              {(["light", "normal", "heavy"] as const).map((amount) => (
                <button
                  type="button"
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
            <button type="button" onClick={() => setIntensityChoice(null)}>
              Cancel
            </button>
          </div>
        )}
        {item.combos.length > 0 && (
          <fieldset>
            <legend>Make it a combo?</legend>
            <label>
              <input
                type="radio"
                checked={!comboId}
                onChange={() => setComboId(null)}
              />
              <span>No thanks</span>
            </label>
            {item.combos.map((combo) => (
              <div key={combo.id}>
                <label>
                  <input
                    type="radio"
                    checked={comboId === combo.id}
                    onChange={() => setComboId(combo.id)}
                  />
                  <span>{combo.name}</span>
                  <b>
                    {combo.basePriceDeltaCents
                      ? `+${money(combo.basePriceDeltaCents)}`
                      : ""}
                  </b>
                </label>
                {comboId === combo.id &&
                  combo.groups.map((group) => (
                    <div className="comboGroup" key={group.id}>
                      <strong>{group.prompt || group.name}</strong>
                      {group.options
                        .filter((o) => o.available)
                        .map((option) => (
                          <label key={option.id}>
                            <input
                              type="radio"
                              name={group.id}
                              checked={(
                                comboSelections[group.id] || []
                              ).includes(option.id)}
                              onChange={() =>
                                setComboSelections((current) => ({
                                  ...current,
                                  [group.id]: [option.id],
                                }))
                              }
                            />
                            <span>{option.name}</span>
                            <b>
                              {option.priceDeltaCents
                                ? `+${money(option.priceDeltaCents)}`
                                : ""}
                            </b>
                          </label>
                        ))}
                    </div>
                  ))}
              </div>
            ))}
          </fieldset>
        )}
        <label className="notes">
          Special instructions
          <textarea
            maxLength={500}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Optional — please don’t include allergy claims"
          />
        </label>
        <div className="dialogAction">
          <div>
            <button onClick={() => setQuantity((q) => Math.max(1, q - 1))}>
              −
            </button>
            <span>{quantity}</span>
            <button onClick={() => setQuantity((q) => Math.min(99, q + 1))}>
              +
            </button>
          </div>
          <button
            disabled={!valid}
            onClick={() =>
              onAdd({
                item,
                variantId,
                quantity,
                modifierSelections: selected,
                modifierAmounts,
                modifierDeclines: item.modifiers
                  .filter(
                    (g) =>
                      g.presentationBehavior !== "pizza_topping" &&
                      g.minSelections === 0 &&
                      !(selected[g.id] || []).length,
                  )
                  .map((g) => g.id),
                pizzaToppings,
                comboId,
                comboSelections,
                specialInstructions: notes,
              })
            }
          >
            Add to order
          </button>
        </div>
      </section>
    </div>
  );
}

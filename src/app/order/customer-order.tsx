"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
import { unwrapHelcimPayResponse } from "@/lib/helcim-pay-response";
import { consolidateQuantities } from "@/lib/cart-line-consolidation";
import {
  DELIVERY_LOCATION_PRESETS,
  deliveryPresetSuggestions,
} from "@/lib/ordering-delivery-presets";
import MxKeyedPaymentDialog, {
  type MxPaymentInitialization,
} from "@/components/mx-keyed-payment-dialog";
import "@/components/mx-keyed-payment-dialog.css";

function localDateValue(value = new Date()) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

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
  allowOptionQuantity: boolean;
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
    opensAt: string | null;
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
    profile?: {
      firstName: string;
      lastName: string;
      email: string;
      phone: string;
    } | null;
    loyalty?: Array<{
      programId: string;
      name: string;
      progress: number;
      quantityRequired: number;
      rewardsAvailable: number;
    }>;
    addresses?: Array<{
      id: string;
      label: string;
      line1: string;
      line2: string;
      city: string;
      state: string;
      postalCode: string;
      formattedAddress: string;
      primary: boolean;
    }>;
    loyaltyAvailableAfterSignIn: boolean;
    giftCardsAcceptedAtPayment: boolean;
  };
  checkout: {
    paymentEnabled: boolean;
    pickupEnabled?: boolean;
    deliveryEnabled?: boolean;
  };
};
type AddressSuggestion = {
  id: string;
  text: string;
  mainText: string;
  secondaryText: string;
  provider?: "google" | "preset";
  deliveryLocationId?: string;
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
    [date, setDate] = useState(() => localDateValue()),
    [slots, setSlots] = useState<string[]>([]),
    [scheduledFor, setScheduledFor] = useState(""),
    [firstName, setFirstName] = useState(""),
    [lastName, setLastName] = useState(""),
    [phone, setPhone] = useState(""),
    [email, setEmail] = useState(""),
    [review, setReview] = useState<any>(null),
    [completedOrder, setCompletedOrder] = useState<any>(null),
    [paymentChoice, setPaymentChoice] = useState<"card" | "pickup" | null>(
      null,
    ),
    [paymentOpen, setPaymentOpen] = useState(false),
    [mxPayment, setMxPayment] = useState<MxPaymentInitialization | null>(null),
    [deliveryAddress, setDeliveryAddress] = useState(""),
    [deliveryUnit, setDeliveryUnit] = useState(""),
    [deliveryInstructions, setDeliveryInstructions] = useState(""),
    [deliveryInstructionsOpen, setDeliveryInstructionsOpen] = useState(false),
    [savedAddressId, setSavedAddressId] = useState(""),
    [addingAddress, setAddingAddress] = useState(false),
    [addressLabel, setAddressLabel] = useState("Home"),
    [makeDefaultAddress, setMakeDefaultAddress] = useState(true),
    [addressSessionToken] = useState(() => crypto.randomUUID()),
    [addressSuggestions, setAddressSuggestions] = useState<AddressSuggestion[]>(
      [],
    ),
    [selectedPlaceId, setSelectedPlaceId] = useState(""),
    [selectedDeliveryLocationId, setSelectedDeliveryLocationId] = useState(""),
    [addressValidationToken, setAddressValidationToken] = useState(""),
    [deliveryDistanceMiles, setDeliveryDistanceMiles] = useState<number | null>(
      null,
    ),
    [deliveryQuoteCents, setDeliveryQuoteCents] = useState<number | null>(null),
    [addressBusy, setAddressBusy] = useState(false),
    [addressPortal, setAddressPortal] = useState<HTMLElement | null>(null),
    [validatedDelivery, setValidatedDelivery] = useState<{
      formattedAddress: string;
    } | null>(null),
    [rewardApplied, setRewardApplied] = useState(false),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    setAddressPortal(document.getElementById("delivery-address-top"));
  }, []);
  const selectedDeliveryLocation = DELIVERY_LOCATION_PRESETS.find(
    (location) => location.id === selectedDeliveryLocationId,
  );
  useEffect(() => {
    setLoading(true);
    fetch(`/api/customer/catalog?serviceType=${serviceType}`, {
      cache: "no-store",
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(await failure(r));
        return r.json();
      })
      .then((value) => {
        setCatalog(value);
        if (value.customer?.profile) {
          setFirstName(value.customer.profile.firstName || "");
          setLastName(value.customer.profile.lastName || "");
          setEmail(value.customer.profile.email || "");
          setPhone(value.customer.profile.phone || "");
        }
        const defaultAddress =
          value.customer?.addresses?.find((address: any) => address.primary) ||
          value.customer?.addresses?.[0];
        if (serviceType === "delivery" && defaultAddress) {
          setSavedAddressId(defaultAddress.id);
          setDeliveryAddress(defaultAddress.formattedAddress);
          setDeliveryUnit(defaultAddress.line2 || "");
          setAddingAddress(false);
        }
      })
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
  useEffect(() => {
    if (
      serviceType !== "delivery" ||
      Boolean(savedAddressId) ||
      deliveryAddress.trim().length < 2 ||
      validatedDelivery
    ) {
      setAddressSuggestions([]);
      return;
    }
    const presets = deliveryPresetSuggestions(deliveryAddress);
    setAddressSuggestions(presets);
    const timer = window.setTimeout(() => {
      fetch("/api/customer/delivery/address/suggest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          input: deliveryAddress,
          sessionToken: addressSessionToken,
        }),
      })
        .then(async (response) =>
          response.ok
            ? response.json()
            : Promise.reject(new Error(await failure(response))),
        )
        .then((body) =>
          setAddressSuggestions([...presets, ...(body.suggestions || [])]),
        )
        .catch(() => setAddressSuggestions(presets));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [
    addressSessionToken,
    deliveryAddress,
    savedAddressId,
    serviceType,
    validatedDelivery,
  ]);
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
  const contactComplete = Boolean(
    firstName.trim() &&
      phone.replace(/\D/g, "").length === 10 &&
      /^\S+@\S+\.\S+$/.test(email.trim()),
  );
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
  useEffect(() => {
    if (serviceType !== "delivery" || deliveryDistanceMiles == null) {
      setDeliveryQuoteCents(null);
      return;
    }
    const controller = new AbortController();
    fetch("/api/customer/delivery/quote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        distanceMiles: deliveryDistanceMiles,
        merchandiseSubtotalCents: estimated,
      }),
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(await failure(response));
        return response.json();
      })
      .then((body) =>
        setDeliveryQuoteCents(Number(body.quote.deliveryFeeCents)),
      )
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError")
          return;
        setDeliveryQuoteCents(null);
      });
    return () => controller.abort();
  }, [deliveryDistanceMiles, estimated, serviceType]);
  function add(line: Omit<CartLine, "key">) {
    setCart((rows) => {
      const next = { ...line, key: crypto.randomUUID() };
      return consolidateQuantities(
        [...rows, next],
        ({ key: _key, quantity: _quantity, ...configuration }) => configuration,
      );
    });
    setActive(null);
    setReview(null);
  }
  async function price() {
    setBusy(true);
    setMessage("");
    try {
      if (
        serviceType === "delivery" &&
        selectedDeliveryLocation?.requiresDropoff !== false &&
        selectedDeliveryLocation &&
        !deliveryUnit
      )
        throw new Error(
          `Choose where at ${selectedDeliveryLocation.name} this delivery is going.`,
        );
      const response = await fetch("/api/customer/cart", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          serviceType,
          timingMode: timing,
          scheduledFor,
          firstName,
          lastName,
          phone,
          email,
          deliveryInstructions:
            serviceType === "delivery" ? deliveryInstructions : "",
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
            specialInstructions: "",
          })),
        }),
      });
      if (!response.ok) throw new Error(await failure(response));
      let priced = (await response.json()).cart;
      if (serviceType === "delivery") {
        const attachedResponse = await fetch(
          `/api/customer/orders/${encodeURIComponent(priced.id)}/delivery`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              enteredAddress: deliveryAddress,
              validationToken: addressValidationToken,
              line2: deliveryUnit,
              customerAddressId: savedAddressId || undefined,
              label: addressLabel,
              makeDefault: makeDefaultAddress,
            }),
          },
        );
        if (!attachedResponse.ok)
          throw new Error(await failure(attachedResponse));
        const attached = await attachedResponse.json();
        setValidatedDelivery(attached.address);
        if (attached.customerAddressId)
          setSavedAddressId(attached.customerAddressId);
        priced = {
          ...priced,
          totalCents: attached.totalCents,
          deliveryFeeCents: attached.deliveryFeeCents,
          delivery: { ...priced.delivery, feePendingAddress: false },
        };
      }
      setReview(priced);
      setRewardApplied(false);
      setPaymentChoice(null);
      return priced;
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Could not price the order.");
      return null;
    } finally {
      setBusy(false);
    }
  }
  async function placeOrder() {
    if (!paymentChoice || busy) return;
    const priced = review || (await price());
    if (!priced) return;
    if (paymentChoice === "card") await payWithMx(priced);
    if (paymentChoice === "pickup") await submitPayLater(priced);
  }
  async function applyLoyaltyReward(programId: string) {
    if (!review?.id || busy) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(
        `/api/customer/orders/${encodeURIComponent(review.id)}/loyalty`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ programId }),
        },
      );
      if (!response.ok) throw new Error(await failure(response));
      const result = await response.json();
      setReview((current: any) => ({
        ...current,
        discountCents: Number(result.order.discount_cents),
        totalCents: Number(result.order.total_cents),
      }));
      setRewardApplied(true);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Reward could not be applied.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function payWithMx(order = review) {
    if (!order?.id || busy) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(
          `/api/customer/orders/${encodeURIComponent(order.id)}/payments/mx`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "initialize" }),
          },
        ),
        body = await response.json();
      if (!response.ok)
        throw new Error(body.error || "Could not start secure checkout.");
      setMxPayment(body);
      setPaymentOpen(true);
    } catch (e) {
      setMessage(
        e instanceof Error ? e.message : "Could not start secure checkout.",
      );
      setBusy(false);
    }
  }
  async function confirmMxPayment(replayId: number) {
    if (!review?.id) return;
    try {
      const response = await fetch(
          `/api/customer/orders/${encodeURIComponent(review.id)}/payments/mx`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "confirm", replayId }),
          },
        ),
        result = await response.json();
      if (!response.ok)
        throw new Error(result.error || "Payment could not be verified.");
      setMxPayment(null);
      setPaymentOpen(false);
      setCompletedOrder(result.order);
      setReview(null);
      setCart([]);
      window.location.assign(
        `/order/confirmation?orderId=${encodeURIComponent(result.order.id)}`,
      );
    } catch (e) {
      setMessage(
        e instanceof Error ? e.message : "Payment could not be verified.",
      );
      setMxPayment(null);
      setPaymentOpen(false);
    } finally {
      setBusy(false);
    }
  }
  async function payWithHelcim(order = review) {
    if (!order?.id || busy) return;
    setBusy(true);
    setMessage("");
    try {
      if (!window.appendHelcimPayIframe) {
        await new Promise<void>((resolve, reject) => {
          const existing = document.querySelector<HTMLScriptElement>(
            'script[data-helcim-pay="true"]',
          );
          if (existing) {
            existing.addEventListener("load", () => resolve(), { once: true });
            existing.addEventListener(
              "error",
              () => reject(new Error("Could not load secure checkout.")),
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
            reject(new Error("Could not load secure checkout."));
          document.head.appendChild(script);
        });
      }
      const endpoint = `/api/customer/orders/${encodeURIComponent(order.id)}/payments/helcim`;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "initialize" }),
      });
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
          initialized.error || "Could not start secure checkout.",
        );
      const checkoutToken = initialized.checkoutToken,
        secretToken = initialized.secretToken;
      const result = await new Promise<any>((resolve, reject) => {
        const listener = async (event: MessageEvent) => {
          if (
            event.origin !== "https://secure.helcim.app" ||
            event.data?.eventName !== `helcim-pay-js-${checkoutToken}`
          )
            return;
          if (
            event.data.eventStatus === "HIDE" ||
            event.data.eventStatus === "ABORTED"
          ) {
            window.removeEventListener("message", listener);
            reject(
              new Error(
                event.data.eventStatus === "ABORTED"
                  ? "The payment was declined."
                  : "Secure checkout was closed.",
              ),
            );
            return;
          }
          if (event.data.eventStatus !== "SUCCESS") return;
          window.removeEventListener("message", listener);
          try {
            const message = unwrapHelcimPayResponse(event.data.eventMessage);
            const confirmed = await fetch(endpoint, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                action: "confirm",
                checkoutToken,
                secretToken,
                data: message.data,
                hash: message.hash,
              }),
            });
            const payload = await confirmed.json();
            if (!confirmed.ok)
              throw new Error(
                payload.error ||
                  "Payment was approved but the order could not be submitted. Please call the deli before retrying.",
              );
            resolve(payload);
          } catch (error) {
            reject(error);
          }
        };
        window.addEventListener("message", listener);
        if (!window.appendHelcimPayIframe) {
          window.removeEventListener("message", listener);
          reject(new Error("Secure checkout did not load."));
          return;
        }
        setPaymentOpen(true);
        window.appendHelcimPayIframe(checkoutToken);
      });
      if (result.needsAssistance) {
        setMessage(
          `Payment was approved, but the order needs staff review: ${result.submissionError || "please call Corner Deli."}`,
        );
      }
      const submittedOrder = result.order;
      setCompletedOrder(submittedOrder);
      setReview(null);
      setCart([]);
      if (!result.needsAssistance && submittedOrder?.id) {
        window.location.assign(
          `/order/confirmation?orderId=${encodeURIComponent(submittedOrder.id)}`,
        );
      }
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Secure checkout failed.",
      );
    } finally {
      window.removeHelcimPayIframe?.();
      setPaymentOpen(false);
      setBusy(false);
    }
  }
  async function validateDeliveryAddressNow(
    enteredAddress: string,
    placeId: string,
  ) {
    setAddressBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/customer/delivery/address/validate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enteredAddress,
          placeId,
          sessionToken: addressSessionToken,
        }),
      });
      if (!response.ok) throw new Error(await failure(response));
      const validated = await response.json();
      setAddressValidationToken(validated.validationToken);
      setValidatedDelivery(validated.address);
      setDeliveryDistanceMiles(Number(validated.route.distanceMiles));
      setAddressSuggestions([]);
    } catch (error) {
      setAddressValidationToken("");
      setValidatedDelivery(null);
      setDeliveryDistanceMiles(null);
      setDeliveryQuoteCents(null);
      setMessage(
        error instanceof Error
          ? error.message
          : "Could not validate the delivery address.",
      );
    } finally {
      setAddressBusy(false);
    }
  }
  async function submitPayLater(order = review) {
    if (!order?.id || busy) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(
        `/api/customer/orders/${encodeURIComponent(order.id)}/payments/helcim`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "pay_later" }),
        },
      );
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error || "Could not submit the order.");
      window.location.assign(
        `/order/confirmation?orderId=${encodeURIComponent(result.order.id)}`,
      );
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Could not submit the order.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="customerOrder">
      {mxPayment && (
        <MxKeyedPaymentDialog
          payment={mxPayment}
          onApproved={confirmMxPayment}
          onCancel={() => {
            setMxPayment(null);
            setPaymentOpen(false);
            setBusy(false);
          }}
        />
      )}
      {paymentOpen && !mxPayment ? (
        <div className="securePaymentBackdrop" aria-hidden="true" />
      ) : null}
      <header className="orderHero">
        <a className="orderBrand" href="/order">
          Corner Deli <span>Order online</span>
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
        <a className="accountLink" href="/account">
          Account
        </a>
      </header>
      <div className="fulfillmentDock">
        <div className="servicePicker" aria-label="Fulfillment type">
          <button className={serviceType === "pickup" ? "selected" : ""} onClick={() => setServiceType("pickup")}><span aria-hidden="true">▣</span> Pickup</button>
          <button disabled={!catalog?.delivery.enabled} className={serviceType === "delivery" ? "selected" : ""} onClick={() => setServiceType("delivery")}><span aria-hidden="true">⌂</span> Delivery</button>
        </div>
      </div>
      <section className="orderIntro">
        <div>
          <p className="eyebrow">Made your way</p>
          <h1>What sounds good?</h1>
          <p>Browse the full menu anytime.</p>
        </div>
        <div className="fulfillmentControls">
          <section
            id="delivery-address-top"
            className={
              serviceType === "delivery"
                ? "topDeliveryAddress active"
                : "topDeliveryAddress"
            }
          />
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
          <span className="categorySwipeHint" aria-hidden="true">
            Swipe →
          </span>
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
          <div className="cartSummary" aria-label="Order total">
            <div>
              <span>{review ? "Food order" : "Estimated food order"}</span>
              <strong>
                {money(Number(review?.subtotalCents ?? estimated))}
              </strong>
            </div>
            {review && Number(review.discountCents) > 0 && (
              <div className="discount">
                <span>Discounts</span>
                <strong>−{money(Number(review.discountCents))}</strong>
              </div>
            )}
            {serviceType === "delivery" && (
              <div>
                <span>Delivery fee</span>
                <strong>
                  {review && !review.delivery?.feePendingAddress
                    ? money(Number(review.deliveryFeeCents || 0))
                    : deliveryQuoteCents != null
                      ? money(deliveryQuoteCents)
                      : validatedDelivery
                        ? "Calculating…"
                        : "Choose address"}
                </strong>
              </div>
            )}
            {review &&
              (serviceType !== "delivery" ||
                !review.delivery?.feePendingAddress) && (
                <div className="cartTotal">
                  <span>Total</span>
                  <strong>{money(Number(review.totalCents))}</strong>
                </div>
              )}
          </div>
          <fieldset>
            <legend>When?</legend>
            <div className="choiceRow" role="group" aria-label="Order timing">
              <button
                type="button"
                className="choiceButton"
                aria-pressed={timing === "asap"}
                onClick={() => {
                  setTiming("asap");
                  setScheduledFor("");
                }}
              >
                {catalog && !catalog.availability.open ? "ASAP preorder" : "ASAP"}
              </button>
              <button
                type="button"
                className="choiceButton"
                aria-pressed={timing === "future"}
                onClick={() => {
                  setTiming("future");
                  setDate((current) => current || localDateValue());
                }}
              >
                {catalog && !catalog.availability.open ? "Future preorder" : "Future"}
              </button>
            </div>
            {timing === "future" && (
              <>
                <input
                  aria-label="Future order date"
                  type="date"
                  value={date}
                  min={localDateValue()}
                  inputMode="none"
                  onClick={(event) => event.currentTarget.showPicker?.()}
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
              <strong>About 1 hour</strong> — we’ll get it there as fast as we
              can. {money(catalog.delivery.minimumOrderCents)} food order
              minimum · delivery fee based on distance · up to{" "}
              {catalog.delivery.maxDistanceMiles} miles.
            </p>
          )}
          {serviceType === "delivery" && (
            <div className="deliveryInstructions">
              <button
                type="button"
                className="choiceButton"
                aria-expanded={deliveryInstructionsOpen}
                onClick={() => setDeliveryInstructionsOpen((open) => !open)}
              >
                {deliveryInstructions.trim()
                  ? "Edit delivery instructions"
                  : "+ Add delivery instructions"}
              </button>
              {deliveryInstructionsOpen && (
                <label>
                  Delivery instructions
                  <textarea
                    autoFocus
                    maxLength={500}
                    value={deliveryInstructions}
                    onChange={(event) =>
                      setDeliveryInstructions(event.target.value)
                    }
                    placeholder="For example: side door, ring bell, or call on arrival"
                  />
                </label>
              )}
            </div>
          )}
          {serviceType === "delivery" &&
            addressPortal &&
            createPortal(
              <fieldset className="deliveryAddress">
                <legend>Delivery address</legend>
                {validatedDelivery ? (
                  <div className="validatedAddress">
                    <strong>✓ {validatedDelivery.formattedAddress}</strong>
                    <button
                      type="button"
                      onClick={() => {
                        setValidatedDelivery(null);
                        setAddressValidationToken("");
                        setDeliveryDistanceMiles(null);
                        setDeliveryQuoteCents(null);
                        setSavedAddressId("");
                        setReview(null);
                      }}
                    >
                      Change
                    </button>
                    <input
                      aria-label="Apartment, suite, or delivery note"
                      placeholder="Apartment, suite, or delivery note (optional)"
                      value={deliveryUnit}
                      onChange={(event) => setDeliveryUnit(event.target.value)}
                    />
                  </div>
                ) : (
                  <>
                    {(catalog?.customer.addresses?.length || 0) > 0 &&
                      !addingAddress && (
                        <div className="savedAddressChoices">
                          {catalog!.customer.addresses!.map((address) => (
                            <button
                              type="button"
                              key={address.id}
                              className={
                                savedAddressId === address.id ? "selected" : ""
                              }
                              onClick={() => {
                                setSavedAddressId(address.id);
                                setDeliveryAddress(address.formattedAddress);
                                setDeliveryUnit(address.line2);
                                setSelectedPlaceId("");
                                setAddressValidationToken("");
                                setValidatedDelivery({
                                  formattedAddress: address.formattedAddress,
                                });
                                void validateDeliveryAddressNow(
                                  address.formattedAddress,
                                  "",
                                );
                              }}
                            >
                              <strong>
                                {address.label}
                                {address.primary ? " · Default" : ""}
                              </strong>
                              <small>
                                {address.formattedAddress}
                                {address.line2 ? ` · ${address.line2}` : ""}
                              </small>
                            </button>
                          ))}
                          <button
                            type="button"
                            onClick={() => {
                              setAddingAddress(true);
                              setSavedAddressId("");
                              setDeliveryAddress("");
                              setDeliveryUnit("");
                              setMakeDefaultAddress(false);
                              setValidatedDelivery(null);
                              setAddressValidationToken("");
                            }}
                          >
                            + Add another address
                          </button>
                        </div>
                      )}
                    {((catalog?.customer.addresses?.length || 0) === 0 ||
                      addingAddress) && (
                      <>
                        {addingAddress && (
                          <button
                            type="button"
                            className="useSavedAddress"
                            onClick={() => {
                              const address =
                                catalog?.customer.addresses?.find(
                                  (row) => row.primary,
                                ) || catalog?.customer.addresses?.[0];
                              if (address) {
                                setAddingAddress(false);
                                setSavedAddressId(address.id);
                                setDeliveryAddress(address.formattedAddress);
                                setDeliveryUnit(address.line2);
                                setValidatedDelivery({
                                  formattedAddress: address.formattedAddress,
                                });
                                void validateDeliveryAddressNow(
                                  address.formattedAddress,
                                  "",
                                );
                              }
                            }}
                          >
                            Use a saved address
                          </button>
                        )}
                        <input
                          aria-label="Delivery address"
                          autoComplete="street-address"
                          placeholder="Start typing your street address"
                          value={deliveryAddress}
                          onChange={(event) => {
                            setDeliveryAddress(event.target.value);
                            setSavedAddressId("");
                            setSelectedPlaceId("");
                            setSelectedDeliveryLocationId("");
                            setDeliveryUnit("");
                            setAddressValidationToken("");
                            setValidatedDelivery(null);
                          }}
                        />
                        {addressSuggestions.length > 0 && (
                          <div className="addressSuggestions">
                            {addressSuggestions.map((suggestion) => (
                              <button
                                type="button"
                                key={suggestion.id}
                                onClick={() => {
                                  setDeliveryAddress(suggestion.text);
                                  setSelectedPlaceId(
                                    suggestion.provider === "preset"
                                      ? ""
                                      : suggestion.id,
                                  );
                                  setSelectedDeliveryLocationId(
                                    suggestion.deliveryLocationId || "",
                                  );
                                  setDeliveryUnit("");
                                  setAddressSuggestions([]);
                                  void validateDeliveryAddressNow(
                                    suggestion.text,
                                    suggestion.provider === "preset"
                                      ? ""
                                      : suggestion.id,
                                  );
                                }}
                              >
                                <strong>{suggestion.mainText}</strong>
                                <small>{suggestion.secondaryText}</small>
                              </button>
                            ))}
                          </div>
                        )}
                        {selectedDeliveryLocation?.requiresDropoff !== false &&
                          selectedDeliveryLocation && (
                            <div className="addressSuggestions">
                              <strong>
                                {selectedDeliveryLocation.id ===
                                "state-hospital"
                                  ? "Where at?"
                                  : `Where at ${selectedDeliveryLocation.name}?`}
                              </strong>
                              {selectedDeliveryLocation.dropoffs.map(
                                (dropoff) => (
                                  <button
                                    type="button"
                                    key={dropoff}
                                    className={
                                      deliveryUnit === dropoff ? "selected" : ""
                                    }
                                    onClick={() => setDeliveryUnit(dropoff)}
                                  >
                                    <strong>{dropoff}</strong>
                                  </button>
                                ),
                              )}
                            </div>
                          )}
                        <input
                          aria-label="Apartment, suite, or delivery note"
                          placeholder="Apartment, suite, or location note (optional)"
                          value={deliveryUnit}
                          onChange={(event) =>
                            setDeliveryUnit(event.target.value)
                          }
                        />
                        {addressBusy && <small>Validating address…</small>}
                        {catalog?.customer.authenticated && (
                          <>
                            <input
                              aria-label="Address label"
                              placeholder="Address label, such as Home or Work"
                              value={addressLabel}
                              onChange={(event) =>
                                setAddressLabel(event.target.value)
                              }
                            />
                            <label className="defaultAddressCheck">
                              <input
                                type="checkbox"
                                checked={makeDefaultAddress}
                                onChange={(event) =>
                                  setMakeDefaultAddress(event.target.checked)
                                }
                              />{" "}
                              Make this my default delivery address
                            </label>
                          </>
                        )}
                      </>
                    )}
                  </>
                )}
              </fieldset>,
              addressPortal,
            )}
          <fieldset className="customerContact">
              <legend>Contact</legend>
              <input
                aria-label="First name"
                autoComplete="given-name"
                placeholder="First name"
                value={firstName}
                onChange={(event) => setFirstName(event.target.value)}
              />
              <input
                aria-label="Last name"
                autoComplete="family-name"
                placeholder="Last name"
                value={lastName}
                onChange={(event) => setLastName(event.target.value)}
              />
              <input
                aria-label="Phone number"
                autoComplete="tel"
                inputMode="tel"
                placeholder="10-digit phone"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
              />
              <input
                aria-label="Email address"
                autoComplete="email"
                inputMode="email"
                type="email"
                placeholder="Email for order confirmation"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
              {catalog?.customer.authenticated && !contactComplete && (
                <small className="contactHint">
                  Complete the missing contact details once; we’ll save them
                  for future orders.
                </small>
              )}
          </fieldset>
          {catalog?.checkout.paymentEnabled && (
            <div
              className="paymentOptionRow"
              role="group"
              aria-label="Payment method"
            >
              <button
                type="button"
                className="choiceButton"
                aria-pressed={paymentChoice === "card"}
                onClick={() => setPaymentChoice("card")}
              >
                Credit or debit
              </button>
              <button
                type="button"
                className="choiceButton"
                aria-pressed={paymentChoice === "pickup"}
                onClick={() => setPaymentChoice("pickup")}
              >
                {serviceType === "delivery"
                  ? "Pay at delivery"
                  : "Pay at pickup"}
              </button>
            </div>
          )}
          {catalog && !catalog.availability.open && (
            <aside className="closedNotice preOpenNotice">
              <strong>{timing === "asap" ? "ASAP preorder" : "Future preorder"}</strong>
              <span>{timing === "asap" && catalog.availability.opensAt ? <>We open at {new Date(catalog.availability.opensAt).toLocaleString([], { weekday:"short", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })}. Your estimated {serviceType === "delivery" ? "delivery time is about 1 hour after opening" : "pickup time is about 30 minutes after opening"}.</> : "Choose the date and time you want this preorder ready."}</span>
            </aside>
          )}
          <button
            className="reviewButton"
            disabled={
              !paymentChoice ||
              !cart.length ||
              busy ||
              !firstName.trim() ||
              phone.replace(/\D/g, "").length !== 10 ||
              !/^\S+@\S+\.\S+$/.test(email.trim()) ||
              (timing === "future" && !scheduledFor) ||
              (!catalog?.availability.orderable && timing === "asap") ||
              (serviceType === "delivery" &&
                deliveryAddress.trim().length < 5) ||
              (serviceType === "delivery" &&
                !savedAddressId &&
                !addressValidationToken) ||
              addressBusy
            }
            onClick={() => void placeOrder()}
          >
            {busy
              ? "Placing order…"
              : !paymentChoice
                ? "Choose a payment method"
                : paymentChoice === "card"
                  ? "Place order and pay"
                  : `Place order — pay at ${serviceType === "delivery" ? "delivery" : "pickup"}`}
          </button>
          {message && (
            <p className="orderError" role="alert">
              {message}
            </p>
          )}
          {review && (
            <div className="serverReview">
              <p>
                {serviceType === "delivery" && !validatedDelivery
                  ? "Finish delivery details"
                  : "Choose payment"}
              </p>
              <small>
                {serviceType === "delivery"
                  ? "About 1 hour — we’ll get it there as fast as we can."
                  : review.timingMessage}
              </small>
              {catalog?.checkout.paymentEnabled ? (
                <div className="paymentChoices">
                  {catalog.customer.loyalty
                    ?.filter((program) => program.rewardsAvailable > 0)
                    .map((program) => (
                      <div
                        className="loyaltyRewardOffer"
                        key={program.programId}
                      >
                        <div>
                          <strong>Free plain Jumbo Thin available</strong>
                          <small>
                            Base pizza is free. Added toppings are charged
                            normally.
                          </small>
                        </div>
                        <button
                          type="button"
                          className="choiceButton"
                          disabled={busy || rewardApplied}
                          onClick={() =>
                            void applyLoyaltyReward(program.programId)
                          }
                        >
                          {rewardApplied
                            ? "Applied — redeemed when placed"
                            : "Apply free pizza"}
                        </button>
                      </div>
                    ))}
                  {paymentChoice === "card" && (
                    <small>
                      Secure card entry opens over this page. Your order stays
                      underneath.
                    </small>
                  )}
                </div>
              ) : (
                <div className="notLive">
                  Secure checkout is not available right now.
                </div>
              )}
            </div>
          )}
          {completedOrder && (
            <div className="serverReview" role="status">
              <p>Order submitted</p>
              <strong>
                Thank you! Order #{completedOrder.display_number} was paid and
                sent to Corner Deli.
              </strong>
            </div>
          )}
          <div className="tenderNote">
            <span>Loyalty</span>
            <small>
              {catalog?.customer.authenticated
                ? catalog.customer.loyalty?.length
                  ? catalog.customer.loyalty
                      .map(
                        (program) =>
                          `${program.progress} of ${program.quantityRequired} toward your next free ${program.name}${program.rewardsAvailable ? ` · ${program.rewardsAvailable} available now` : ""}`,
                      )
                      .join(" · ")
                  : "Your jumbo pizza purchases will appear here."
                : "Sign in to track progress toward a free jumbo pizza."}
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
    [quantity, setQuantity] = useState(1);
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
  const changeOptionQuantity = (group: Group, id: string, delta: number) =>
    setSelected((current) => {
      const values = current[group.id] || [],
        count = values.filter((value) => value === id).length;
      if (delta > 0 && values.length < group.maxSelections)
        return { ...current, [group.id]: [...values, id] };
      if (delta < 0 && count > 0) {
        const index = values.lastIndexOf(id);
        return {
          ...current,
          [group.id]: values.filter((_, valueIndex) => valueIndex !== index),
        };
      }
      return current;
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
                    ),
                    optionQuantity = (selected[group.id] || []).filter(
                      (id) => id === option.id,
                    ).length;
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
                          {(
                            modifierAmounts[option.id] || "normal"
                          ).toUpperCase()}{" "}
                          ▾
                        </button>
                      )}
                      {isSelected && group.allowOptionQuantity && (
                        <div
                          className="customerModifierQty"
                          aria-label={`${option.name} quantity`}
                        >
                          <button
                            type="button"
                            onClick={() =>
                              changeOptionQuantity(group, option.id, -1)
                            }
                          >
                            −
                          </button>
                          <strong>{optionQuantity}</strong>
                          <button
                            type="button"
                            onClick={() =>
                              changeOptionQuantity(group, option.id, 1)
                            }
                          >
                            +
                          </button>
                        </div>
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
                specialInstructions: "",
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

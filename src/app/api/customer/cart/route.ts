import { isoJson } from "@/lib/timestamp-values";
import { createTimedDraftOrder } from "@/lib/ordering-timed-orders";
import type { VariantConfiguredOrderItemInput } from "@/lib/ordering-orders-with-variants";
import {
  customerOrderingSession,
  customerSessionHash,
} from "@/lib/customer-ordering-session";
import { ensureCustomerOrderingSchema } from "@/lib/customer-ordering-schema";
import { getSql } from "@/lib/db";
import { getDeliveryPricingSettings } from "@/lib/ordering-delivery";
import { addCustomerPhone, createCustomer } from "@/lib/ordering-customers";

export const runtime = "nodejs";

function items(value: unknown): VariantConfiguredOrderItemInput[] {
  if (!Array.isArray(value) || !value.length || value.length > 50)
    throw new Error("Add at least one item to your order.");
  return value.map((raw) => {
    if (!raw || typeof raw !== "object")
      throw new Error("An invalid cart item was submitted.");
    const row = raw as Record<string, unknown>;
    return {
      itemId: String(row.itemId || ""),
      variantId: row.variantId ? String(row.variantId) : null,
      quantity: Math.max(
        1,
        Math.min(99, Math.trunc(Number(row.quantity || 1))),
      ),
      modifierSelections:
        row.modifierSelections && typeof row.modifierSelections === "object"
          ? (row.modifierSelections as Record<string, string[]>)
          : {},
      modifierQuantities:
        row.modifierQuantities && typeof row.modifierQuantities === "object"
          ? (row.modifierQuantities as Record<string, number>)
          : {},
      // Light / extra choices ("Light Mayo"): only the three known levels.
      modifierAmounts:
        row.modifierAmounts && typeof row.modifierAmounts === "object"
          ? Object.fromEntries(
              Object.entries(row.modifierAmounts as Record<string, unknown>).filter(
                (entry): entry is [string, "light" | "normal" | "heavy"] =>
                  entry[1] === "light" || entry[1] === "normal" || entry[1] === "heavy",
              ),
            )
          : {},
      modifierDeclines: Array.isArray(row.modifierDeclines)
        ? row.modifierDeclines.map(String)
        : [],
      pizzaToppings: Array.isArray(row.pizzaToppings)
        ? (row.pizzaToppings as VariantConfiguredOrderItemInput["pizzaToppings"])
        : [],
      comboId: row.comboId ? String(row.comboId) : null,
      comboSelections:
        row.comboSelections && typeof row.comboSelections === "object"
          ? (row.comboSelections as Record<string, string[]>)
          : {},
      specialInstructions: String(row.specialInstructions || "").slice(0, 500),
    };
  });
}

/**
 * The website menu hides items and categories turned off for the web channel
 * (POS-only, staff items, retired categories); a hand-built request must not
 * be able to order them either. Mirrors the filters in orderingMenu(…, "web").
 */
async function assertItemsShownOnWebsite(itemIds: string[]) {
  const ids = [...new Set(itemIds.filter(Boolean))];
  if (!ids.length) return;
  const shown = await getSql()`
    SELECT i.id::text AS id
    FROM ordering_menu_items i
    LEFT JOIN ordering_item_overrides o ON o.item_id=i.id
    LEFT JOIN ordering_item_channel_overrides ch ON ch.item_id=i.id AND ch.channel='web'
    JOIN ordering_menu_categories c ON c.id=COALESCE(ch.category_id,o.category_id,i.category_id) AND c.business=i.business AND c.active=TRUE
    LEFT JOIN ordering_category_overrides co ON co.category_id=c.id
    LEFT JOIN ordering_category_channel_overrides cch ON cch.category_id=c.id AND cch.channel='web'
    WHERE i.business='Corner Deli' AND i.active=TRUE AND i.id::text = ANY(${ids})
      AND COALESCE(ch.visible,o.visible,TRUE)=TRUE
      AND COALESCE(cch.visible,co.visible,TRUE)=TRUE`;
  if (shown.length !== ids.length) throw new Error("This menu item is not available online.");
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const serviceType =
      body.serviceType === "delivery"
        ? "delivery"
        : body.serviceType === "curbside"
          ? "curbside"
        : body.serviceType === "pickup"
          ? "pickup"
            : null;
    if (!serviceType)
      return isoJson(
        { error: "Choose pickup or delivery." },
        { status: 400 },
      );
    const timingMode = body.timingMode === "future" ? "future" : "asap";
    let firstName = String(body.firstName || "")
      .trim()
      .slice(0, 80);
    let lastName = String(body.lastName || "")
      .trim()
      .slice(0, 80);
    let phone = String(body.phone || "").replace(/\D/g, "");
    let email = String(body.email || "")
      .trim()
      .toLowerCase()
      .slice(0, 320);
    const { session, setCookie } = customerOrderingSession(request);
    await ensureCustomerOrderingSchema();
    const sql = getSql();
    let needsSavedPhone = false;
    let authenticatedCustomer = false;
    if (session.customerId && session.authenticatedAt) {
      const saved = (
        await sql`SELECT c.first_name,c.last_name,c.email,p.phone
        FROM ordering_customers c
        LEFT JOIN LATERAL (
          SELECT normalized_phone phone FROM ordering_customer_phones
          WHERE customer_id=c.id ORDER BY is_primary DESC,last_used_at DESC NULLS LAST,created_at ASC LIMIT 1
        ) p ON TRUE
        WHERE c.id=${session.customerId} AND c.active=TRUE LIMIT 1`
      )[0];
      if (saved) {
        authenticatedCustomer = true;
        firstName = String(saved.first_name || firstName)
          .trim()
          .slice(0, 80);
        lastName = String(saved.last_name || lastName)
          .trim()
          .slice(0, 80);
        email = String(saved.email || email)
          .trim()
          .toLowerCase()
          .slice(0, 320);
        const savedPhone = String(saved.phone || "")
          .replace(/^\+1/, "")
          .replace(/\D/g, "");
        if (savedPhone.length === 10) phone = savedPhone;
        else needsSavedPhone = true;
      }
    }
    if (!firstName || phone.length !== 10 || !/^\S+@\S+\.\S+$/.test(email))
      return isoJson(
        {
          error:
            "Enter your name, a 10-digit phone number, and a valid email address.",
        },
        { status: 400 },
      );
    if (!authenticatedCustomer)
      return isoJson(
        {
          error: "Verify your mobile number before placing this order.",
          code: "sms_verification_required",
        },
        { status: 403 },
      );
    const requestedFor =
      timingMode === "future"
        ? new Date(String(body.scheduledFor || ""))
        : null;
    if (requestedFor && !Number.isFinite(requestedFor.getTime()))
      return isoJson(
        { error: "Choose a valid future time." },
        { status: 400 },
      );
    const sessionHash = customerSessionHash(session.sessionId);
    await sql`INSERT INTO ordering_customer_web_sessions(session_hash,customer_id,authenticated_at,last_seen_at,expires_at) VALUES(${sessionHash},${session.customerId},${session.authenticatedAt ? new Date(session.authenticatedAt).toISOString() : null},NOW(),${new Date(session.expiresAt).toISOString()}) ON CONFLICT(session_hash) DO UPDATE SET last_seen_at=NOW(),expires_at=EXCLUDED.expires_at`;
    let customerId = session.customerId;
    if (customerId && needsSavedPhone) {
      await addCustomerPhone({
        business: "Corner Deli",
        customerId,
        phone,
        isPrimary: true,
        allowShared: true,
      });
    }
    if (customerId) {
      await sql`UPDATE ordering_customers SET
        first_name=CASE WHEN trim(first_name)='' THEN ${firstName} ELSE first_name END,
        last_name=CASE WHEN trim(last_name)='' THEN ${lastName} ELSE last_name END,
        display_name=CASE WHEN trim(display_name)='' OR display_name=email THEN ${`${firstName} ${lastName}`.trim()} ELSE display_name END,
        email=CASE WHEN trim(email)='' THEN ${email} ELSE email END,
        updated_at=NOW()
        WHERE id=${customerId}`;
      await sql`INSERT INTO ordering_customer_emails(id,customer_id,normalized_email,display_email,is_primary)
        SELECT gen_random_uuid(),${customerId},${email},${email},NOT EXISTS(SELECT 1 FROM ordering_customer_emails WHERE customer_id=${customerId})
        WHERE NOT EXISTS(SELECT 1 FROM ordering_customer_emails WHERE customer_id=${customerId} AND normalized_email=${email})`;
    }
    if (!customerId) {
      const created = await createCustomer({
        business: "Corner Deli",
        firstName,
        lastName,
        phone,
        email,
      });
      customerId = String(created.customer.id);
      await sql`UPDATE ordering_customers SET email=CASE WHEN email='' THEN ${email} ELSE email END WHERE id=${customerId}`;
    }
    const cartItems = items(body.items);
    await assertItemsShownOnWebsite(cartItems.map((item) => item.itemId));
    const order = await createTimedDraftOrder({
      business: "Corner Deli",
      source: "web",
      serviceType,
      customerId,
      callerPhone: phone,
      customerFirstName: firstName,
      customerLastName: lastName,
      createdBy: `web:${sessionHash.slice(0, 16)}`,
      createdByName: "Website guest",
      orderOrigin: "web",
      items: cartItems,
      timingMode,
      requestedFor,
    });
    const deliveryInstructions =
      serviceType === "delivery"
        ? String(body.deliveryInstructions || "")
            .trim()
            .slice(0, 500)
        : "";
    await sql`UPDATE ordering_orders SET email_snapshot=${email},special_instructions=${deliveryInstructions},updated_at=NOW() WHERE id=${order.id}`;
    await sql`UPDATE ordering_customer_web_carts SET replaced_at=NOW() WHERE session_hash=${sessionHash} AND replaced_at IS NULL`;
    await sql`INSERT INTO ordering_customer_web_carts(order_id,session_hash) VALUES(${order.id},${sessionHash})`;
    const lines =
      await sql`SELECT item_name_snapshot name,variant_name_snapshot variant_name,quantity,unit_price_cents,modifier_total_cents,combo_total_cents,line_total_cents FROM ordering_order_items WHERE order_id=${order.id} ORDER BY sort_order,created_at,id`;
    const promotions =
      await sql`SELECT label_snapshot label,discount_cents FROM ordering_order_promotion_applications WHERE order_id=${order.id} ORDER BY application_sequence`;
    const delivery =
      serviceType === "delivery"
        ? await getDeliveryPricingSettings("Corner Deli")
        : null;
    const response = isoJson(
      {
        cart: {
          id: order.id,
          status: "draft",
          serviceType,
          timingMode: order.timing_mode,
          scheduledFor: order.scheduled_for,
          timingMessage: order.timing_message_snapshot,
          lines: lines.map((line) => ({
            name: line.name,
            variantName: line.variant_name,
            quantity: Number(line.quantity),
            unitPriceCents: Number(line.unit_price_cents),
            modifierTotalCents: Number(line.modifier_total_cents),
            comboTotalCents: Number(line.combo_total_cents),
            lineTotalCents: Number(line.line_total_cents),
          })),
          subtotalCents: Number(order.subtotal_cents),
          discountCents: Number(order.discount_cents),
          totalCents: Number(order.total_cents),
          promotions,
          delivery: delivery
            ? {
                feePendingAddress: true,
                minimumOrderCents: delivery.minimumOrderCents,
                maxDistanceMiles: delivery.maxDistanceMiles,
              }
            : null,
          paymentStatus: "unpaid",
        },
        nextStep:
          serviceType === "pickup"
            ? "Pay securely by card to submit this order."
            : "Delivery checkout requires address validation before payment.",
      },
      { status: 201 },
    );
    if (setCookie) response.headers.set("Set-Cookie", setCookie);
    return response;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "The cart could not be priced.";
    const safe =
      /^(Add at least|An invalid|Choose|The selected|This item|This menu item|Menu item|Item quantity|Required|Invalid|A selected|Ordering|Pickup|Delivery|Future|That time|ASAP ordering|Modifier choices|Modifier intensity)/.test(
        message,
      ) || message.endsWith("is currently unavailable.");
    return isoJson(
      { error: safe ? message : "The cart could not be priced." },
      { status: safe ? 409 : 500 },
    );
  }
}

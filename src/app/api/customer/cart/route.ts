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
      return Response.json(
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
      return Response.json(
        {
          error:
            "Enter your name, a 10-digit phone number, and a valid email address.",
        },
        { status: 400 },
      );
    const requestedFor =
      timingMode === "future"
        ? new Date(String(body.scheduledFor || ""))
        : null;
    if (requestedFor && !Number.isFinite(requestedFor.getTime()))
      return Response.json(
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
      items: items(body.items),
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
    const response = Response.json(
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
            ? "Pay securely with Helcim to submit this order."
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
      /^(Add at least|An invalid|Choose|The selected|This item|This menu item|Menu item|Item quantity|Required|Invalid|A selected|Ordering|Pickup|Delivery|Future)/.test(
        message,
      ) || message.endsWith("is currently unavailable.");
    return Response.json(
      { error: safe ? message : "The cart could not be priced." },
      { status: safe ? 409 : 500 },
    );
  }
}

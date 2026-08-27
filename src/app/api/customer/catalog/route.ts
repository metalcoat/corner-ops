import { orderingMenuWithVariants } from "@/lib/ordering-menu-variants";
import { applyScheduledMenuAvailability } from "@/lib/ordering-menu-availability";
import { resolveOrderingAvailability } from "@/lib/ordering-availability";
import { getDeliveryPricingSettings } from "@/lib/ordering-delivery";
import { getSql } from "@/lib/db";
import { ensureOrderingPromotionSchema } from "@/lib/ordering-promotion-schema";
import { customerOrderingSession } from "@/lib/customer-ordering-session";
import { helcimStatus } from "@/lib/helcim";
import { loyaltyStatus } from "@/lib/ordering-loyalty";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const requested = params.get("scheduledFor");
    const at = requested ? new Date(requested) : new Date();
    if (!Number.isFinite(at.getTime()))
      return Response.json({ error: "Invalid menu time." }, { status: 400 });
    const serviceType = ["pickup", "delivery"].includes(
      params.get("serviceType") || "",
    )
      ? params.get("serviceType")!
      : "pickup";
    const [raw, availability, delivery] = await Promise.all([
      orderingMenuWithVariants("Corner Deli", "web"),
      resolveOrderingAvailability({ business: "Corner Deli", serviceType }),
      getDeliveryPricingSettings("Corner Deli"),
    ]);
    const scheduled = await applyScheduledMenuAvailability(
      "Corner Deli",
      at,
      raw as unknown as Array<Record<string, any>>,
    );
    await ensureOrderingPromotionSchema();
    const promotions =
      await getSql()`SELECT customer_label FROM ordering_promotions WHERE business='Corner Deli' AND active=TRUE AND automatic=TRUE AND customer_label<>'' ORDER BY priority DESC,id`;
    const categories = scheduled.map((category: any) => ({
      id: category.id,
      displayName: category.displayName,
      parentId: category.parentId,
      presentationOnly: category.presentationOnly,
      items: category.items.map((item: any) => ({
        id: item.id,
        categoryId: item.categoryId,
        displayName: item.name,
        description: item.description || "",
        basePriceCents: item.basePriceCents,
        available: Boolean(item.available),
        imageUrl: item.imageUrl
          ? item.imageUrl.replace(
              "/api/ordering/media/",
              "/api/customer/media/",
            )
          : null,
        imageAlt: item.imageAlt,
        variants: item.variants.map((variant: any) => ({
          id: variant.id,
          name: variant.name,
          basePriceCents: variant.basePriceCents,
          defaultVariant: variant.defaultVariant,
          available: Boolean(variant.available),
          modifierPrices: variant.modifierPrices,
        })),
        modifiers: item.modifiers
          .filter((group: any) => group.presentationContext !== "hidden")
          .map((group: any) => ({
            ...group,
            options: group.options.map((option: any) => ({
              id: option.id,
              name: option.name,
              priceDeltaCents: option.priceDeltaCents,
              available: Boolean(option.available),
              defaultSelected: Boolean(option.defaultSelected),
              includedQuantity: option.includedQuantity,
            })),
          })),
        combos: item.combos,
      })),
    }));
    const featuredItems = categories
      .flatMap((category: any) =>
        category.items.filter((item: any) => item.available).slice(0, 1),
      )
      .toSorted(
        (left: any, right: any) =>
          Number(Boolean(right.imageUrl)) - Number(Boolean(left.imageUrl)),
      )
      .slice(0, 6);
    const { session, setCookie } = customerOrderingSession(request);
    const profile =
      session.customerId && session.authenticatedAt
        ? (
            await getSql()`SELECT c.first_name,c.last_name,c.email,p.phone
              FROM ordering_customers c
              LEFT JOIN LATERAL (
                SELECT COALESCE(NULLIF(display_phone,''),normalized_phone) phone
                FROM ordering_customer_phones
                WHERE customer_id=c.id
                ORDER BY is_primary DESC,last_used_at DESC NULLS LAST,created_at ASC
                LIMIT 1
              ) p ON TRUE
              WHERE c.id=${session.customerId} AND c.active=TRUE LIMIT 1`
          )[0]
        : null;
    const loyalty =
      session.customerId && session.authenticatedAt
        ? await loyaltyStatus(session.customerId)
        : [];
    const response = Response.json({
      business: "Corner Deli",
      serverTime: new Date().toISOString(),
      scheduledFor: at.toISOString(),
      availability,
      categories,
      featuredItems,
      promotions: promotions.map((row) => String(row.customer_label)),
      delivery: {
        enabled: delivery.enabled,
        minimumOrderCents: delivery.minimumOrderCents,
        maxDistanceMiles: delivery.maxDistanceMiles,
        feeBands: delivery.feeBands,
      },
      customer: {
        authenticated: Boolean(session.customerId && session.authenticatedAt),
        profile: profile
          ? {
              firstName: profile.first_name,
              lastName: profile.last_name,
              email: profile.email,
              phone: String(profile.phone || "").replace(/^\+1/, ""),
            }
          : null,
        loyalty,
        loyaltyAvailableAfterSignIn: true,
        giftCardsAcceptedAtPayment: true,
      },
      checkout: {
        paymentEnabled: helcimStatus().checkoutEnabled,
        provider: "helcim",
        pickupEnabled: true,
        deliveryEnabled: false,
      },
    });
    if (setCookie) response.headers.set("Set-Cookie", setCookie);
    return response;
  } catch (error) {
    console.error(error);
    return Response.json(
      { error: "The menu is temporarily unavailable." },
      { status: 500 },
    );
  }
}

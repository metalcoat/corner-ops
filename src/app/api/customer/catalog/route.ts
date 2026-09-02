import { orderingMenuWithVariants } from "@/lib/ordering-menu-variants";
import { applyScheduledMenuAvailability } from "@/lib/ordering-menu-availability";
import { resolveOrderingAvailability } from "@/lib/ordering-availability";
import { getDeliveryPricingSettings } from "@/lib/ordering-delivery";
import { getSql } from "@/lib/db";
import { ensureOrderingPromotionSchema } from "@/lib/ordering-promotion-schema";
import { customerOrderingSession } from "@/lib/customer-ordering-session";
import { paymentProviderStatus } from "@/lib/payment-provider";
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
      resolveOrderingAvailability({ business: "Corner Deli", serviceType, allowPreOpenAsap: true }),
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
      items: category.items.filter((item: any) => item.available).map((item: any) => ({
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
            minSelections:
              /wings?/i.test(item.name) &&
              /wing sauce|flavou?r/i.test(group.name)
                ? 1
                : group.minSelections,
          }))
          .toSorted((left: any, right: any) => {
            if (!/wings?/i.test(item.name)) return 0;
            const rank = (group: any) =>
              /wing sauce|flavou?r/i.test(group.name)
                ? 0
                : /add.?ons?|sides?/i.test(group.name)
                  ? 1
                  : 2;
            return rank(left) - rank(right);
          })
          .map((group: any) => ({
            ...group,
            options: group.options.map((option: any) => ({
              id: option.id,
              name: option.name,
              priceDeltaCents: option.priceDeltaCents,
              available: Boolean(option.available),
              defaultSelected:
                Boolean(option.defaultSelected) ||
                (/wings?/i.test(item.name) &&
                  /^(blue cheese(?: \(4oz\))?|celery)$/i.test(option.name)),
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
    const savedAddresses =
      session.customerId && session.authenticatedAt
        ? await getSql()`SELECT id,label,line1,line2,city,state,postal_code,standardized_address,provider,provider_reference_id,latitude,longitude,is_primary
            FROM ordering_customer_addresses
            WHERE customer_id=${session.customerId} AND active=TRUE AND latitude IS NOT NULL AND longitude IS NOT NULL
            ORDER BY is_primary DESC,last_used_at DESC NULLS LAST,created_at DESC`
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
        addresses: savedAddresses.map((address) => ({
          id: String(address.id),
          label: String(address.label || "Address"),
          line1: String(address.line1),
          line2: String(address.line2 || ""),
          city: String(address.city),
          state: String(address.state),
          postalCode: String(address.postal_code),
          formattedAddress: String(
            address.standardized_address ||
              [address.line1, address.city, address.state, address.postal_code]
                .filter(Boolean)
                .join(", "),
          ),
          primary: Boolean(address.is_primary),
        })),
        loyaltyAvailableAfterSignIn: true,
        giftCardsAcceptedAtPayment: true,
      },
      checkout: {
        paymentEnabled: paymentProviderStatus().configured,
        provider: paymentProviderStatus().provider,
        pickupEnabled: true,
        deliveryEnabled: delivery.enabled,
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

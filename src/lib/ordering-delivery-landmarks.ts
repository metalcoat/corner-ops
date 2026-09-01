import { randomUUID } from "node:crypto";
import {
  routeDeliveryAddress,
  validateDeliveryAddress,
} from "@/lib/ordering-address";
import { saveOrderDeliveryAddress } from "@/lib/ordering-address-schema";
import { quoteDelivery } from "@/lib/ordering-delivery";
import { getSql } from "@/lib/db";

const landmarks: Array<{ aliases: RegExp; address: string }> = [
  {
    aliases: /^(?:the )?walmart(?: supercenter)?$/i,
    address: "3000 Ford Street Extension, Ogdensburg, NY 13669",
  },
  {
    aliases: /^(?:the )?(?:ogdensburg )?(?:bowl|bowling alley)$/i,
    address: "1121 Patterson Street, Ogdensburg, NY 13669",
  },
  {
    aliases: /^how(?:ie|y)'?s(?: e| bar)?$/i,
    address: "809 New York Avenue, Ogdensburg, NY 13669",
  },
  {
    aliases: /^(?:the )?shipwreck(?:ed|'d)?(?: bar(?: and grill)?)?$/i,
    address: "17 Commerce Street, Ogdensburg, NY 13669",
  },
  {
    aliases: /^(?:the )?(?:hospital|claxton(?: hepburn)?|claxton-hepburn)$/i,
    address: "214 King Street, Ogdensburg, NY 13669",
  },
  {
    aliases: /^(?:the )?(?:state hospital|psych(?:iatric)? center|st\.? lawrence psych(?:iatric)? center|saint lawrence psych(?:iatric)? center)$/i,
    address: "1 Chimney Point Drive, Ogdensburg, NY 13669",
  },
  {
    aliases: /^(?:new )ansen(?: corporation)?(?: new)?$/i,
    address: "830 Proctor Avenue, Ogdensburg, NY 13669",
  },
  {
    aliases: /^(?:old )ansen(?: corporation)?(?: old)?$/i,
    address: "100 Chimney Point Drive, Ogdensburg, NY 13669",
  },
  {
    aliases: /^(?:the )?(?:prison|riverview(?: correctional facility)?)$/i,
    address: "1110 Tibbitts Drive, Ogdensburg, NY 13669",
  },
  {
    aliases: /^(?:the )?advance(?:d)? auto(?: parts)?$/i,
    address: "1210 Paterson Street, Ogdensburg, NY 13669",
  },
  {
    aliases: /^(?:the )?sunoco(?: on)? canton(?: street)?$/i,
    address: "728 Canton Street, Ogdensburg, NY 13669",
  },
  {
    aliases: /^(?:the )?sunoco(?: on)? champlain(?: street)?$/i,
    address: "301 Champlain Street, Ogdensburg, NY 13669",
  },
  {
    aliases: /^(?:the )?sunoco(?: on)? (?:new york|ny)(?: avenue| ave)?$/i,
    address: "1117 New York Avenue, Ogdensburg, NY 13669",
  },
];

export function resolveDeliveryLandmark(spoken: string) {
  const value = spoken.replace(/\s+/g, " ").trim();
  if (/^ansen(?: corporation)?$/i.test(value))
    return { clarification: "Do you mean new Ansen or old Ansen?" };
  if (/^(?:the )?sunoco$/i.test(value))
    return {
      clarification:
        "Which Sunoco: Canton Street, Champlain Street, or New York Avenue?",
    };
  const match = landmarks.find((row) => row.aliases.test(value));
  return match ? { address: match.address } : { address: value };
}

export async function attachSpokenDeliveryAddress(
  orderId: string,
  spoken: string,
  line2 = "",
) {
  const resolved = resolveDeliveryLandmark(spoken);
  if (resolved.clarification) throw new Error(resolved.clarification);
  const address = await validateDeliveryAddress({
    enteredAddress: resolved.address || spoken,
    sessionToken: randomUUID(),
  });
  const route = await routeDeliveryAddress(address),
    sql = getSql();
  const order = (
    await sql`SELECT subtotal_cents FROM ordering_orders WHERE id=${orderId}`
  )[0];
  const quote = await quoteDelivery({
    business: "Corner Deli",
    distanceMiles: route.distanceMiles,
    merchandiseSubtotalCents: Number(order.subtotal_cents),
  });
  await saveOrderDeliveryAddress({ orderId, address, line2, route });
  await sql`UPDATE ordering_orders SET delivery_fee_cents=${quote.deliveryFeeCents},total_cents=GREATEST(0,subtotal_cents-discount_cents+tax_cents+tip_cents+${quote.deliveryFeeCents}),amount_due_cents=GREATEST(0,subtotal_cents-discount_cents+tax_cents+tip_cents+${quote.deliveryFeeCents}-paid_cents),version=version+1,updated_at=NOW() WHERE id=${orderId}`;
  return { address, route, quote };
}

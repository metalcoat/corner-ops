import { withTablet } from "@/lib/car-tablet-route";
import { assertRateLimit, clearRateLimit, recordRateLimitFailure, type RateLimitPolicy } from "@/lib/rate-limit";
import { signInDriver, signOutDriver } from "@/lib/car-tablet";

export const runtime = "nodejs";

const policies = (tabletId: string, business: string): RateLimitPolicy[] => [
  { scope: "car-tablet-pin", discriminator: `tablet:${tabletId}`, maxFailures: 8, windowSeconds: 15 * 60, blockSeconds: 15 * 60 },
  { scope: "car-tablet-pin", discriminator: `business:${business}`, maxFailures: 50, windowSeconds: 15 * 60, blockSeconds: 15 * 60 },
];

/** The driver signs in on the car tablet with their POS PIN. */
export function POST(request: Request) {
  return withTablet(request, async (tablet) => {
    const limits = policies(tablet.id, tablet.business);
    await assertRateLimit(limits);
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    try {
      const driver = await signInDriver(tablet, body.pin);
      await clearRateLimit(limits);
      return { ok: true, driver };
    } catch (error) {
      await recordRateLimitFailure(limits);
      throw error;
    }
  });
}

export function DELETE(request: Request) {
  return withTablet(request, (tablet) => signOutDriver(tablet));
}

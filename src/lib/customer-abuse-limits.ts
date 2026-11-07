// Limits on the public customer endpoints that cost money or touch the card
// processor: sign-in codes (each SMS is billed by Telnyx) and card checkout
// starts (card testing can trip MX's decline limits or freeze the account).
// Keys use the Cloudflare visitor address; the "business:" keys are global
// caps that a successful sign-in never clears.
import { clientIp, consumeRateLimit, type RateLimitPolicy } from "@/lib/rate-limit";

const HOUR = 60 * 60;

export async function limitSignInCodeRequest(request: Request, kind: "sms" | "email"): Promise<void> {
  const policies: RateLimitPolicy[] = [
    { scope: `customer-${kind}-code`, discriminator: `ip:${clientIp(request)}`, maxFailures: 10, windowSeconds: HOUR, blockSeconds: HOUR },
    { scope: `customer-${kind}-code`, discriminator: `business:Corner Deli:daily`, maxFailures: kind === "sms" ? 400 : 600, windowSeconds: 24 * HOUR, blockSeconds: HOUR },
  ];
  await consumeRateLimit(policies);
}

export async function limitCardCheckoutStart(request: Request, sessionHash: string): Promise<void> {
  const policies: RateLimitPolicy[] = [
    { scope: "customer-card-checkout", discriminator: `session:${sessionHash}`, maxFailures: 8, windowSeconds: HOUR, blockSeconds: HOUR },
    { scope: "customer-card-checkout", discriminator: `ip:${clientIp(request)}`, maxFailures: 20, windowSeconds: HOUR, blockSeconds: HOUR },
  ];
  await consumeRateLimit(policies);
}

export { usOrCanadaMobile } from "@/lib/phone-region";

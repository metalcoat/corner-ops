#!/usr/bin/env node
import { loadEnvFile } from "node:process";
import {
  addressForOrder, createAddressValidationToken, normalizeAddressInput,
  readAddressValidationToken, routeDeliveryAddress, suggestDeliveryAddresses,
  validateDeliveryAddress,
} from "../src/lib/ordering-address";

try { loadEnvFile("/opt/corner-ops/.env"); } catch { /* CI supplies its own environment. */ }
process.env.SESSION_SECRET ||= "address-workflow-test-secret-that-is-not-a-credential";
const env = { ADDRESS_PROVIDER: "google", GOOGLE_MAPS_API_KEY: "mock-key", DELI_ORIGIN_LATITUDE: "44.7", DELI_ORIGIN_LONGITUDE: "-75.5" } as unknown as NodeJS.ProcessEnv;
let requests = 0;
const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
  requests += 1;
  const url = String(input);
  if (url.includes("places:autocomplete")) return Response.json({ suggestions: [{ placePrediction: { placeId: "place-1", text: { text: "12 Main St, Testville, NY" }, structuredFormat: { mainText: { text: "12 Main St" }, secondaryText: { text: "Testville, NY" } } } }] });
  if (url.includes("validateAddress")) return Response.json({ result: { verdict: { addressComplete: true, validationGranularity: "PREMISE" }, address: { formattedAddress: "12 Main St, Testville, NY 10001, USA", postalAddress: { addressLines: ["12 Main St"], locality: "Testville", administrativeArea: "NY", postalCode: "10001", regionCode: "US" } }, geocode: { location: { latitude: 44.7, longitude: -75.4 } } } });
  if (url.includes("computeRoutes")) return Response.json({ routes: [{ distanceMeters: 6437.376, duration: "720s" }] });
  throw new Error(`Unexpected mock request: ${url} ${String(init?.method)}`);
};

async function main() {
  if (normalizeAddressInput("  12   Main ") !== "12 Main") throw new Error("Input normalization failed.");
  const before = requests;
  if ((await suggestDeliveryAddresses("1", "test-session-token-123456", { env, fetcher: fetcher as typeof fetch })).length !== 0 || requests !== before) throw new Error("Short input contacted provider.");
  const suggestions = await suggestDeliveryAddresses("12", "test-session-token-123456", { env, fetcher: fetcher as typeof fetch });
  if (suggestions[0]?.text !== "12 Main St, Testville, NY" || JSON.stringify(suggestions).includes("mock-key")) throw new Error("Suggestion normalization leaked provider data.");
  const address = await validateDeliveryAddress({ enteredAddress: suggestions[0].text, placeId: suggestions[0].id, sessionToken: "test-session-token-123456" }, { env, fetcher: fetcher as typeof fetch });
  const token = createAddressValidationToken(address);
  if (!readAddressValidationToken(token, suggestions[0].text)) throw new Error("Validated address token was rejected.");
  if (readAddressValidationToken(token, "99 Changed St")) throw new Error("Changed address remained validated.");
  if (addressForOrder("pickup", "", "") !== null || addressForOrder("dine_in", "", "") !== null) throw new Error("Non-delivery order required an address.");
  let deliveryRejected = false;
  try { addressForOrder("delivery", "", ""); } catch { deliveryRejected = true; }
  if (!deliveryRejected) throw new Error("Delivery without validation was accepted.");
  const route = await routeDeliveryAddress(address, { env, fetcher: fetcher as typeof fetch });
  if (Math.abs(route.distanceMiles - 4) > .01 || route.durationSeconds !== 720) throw new Error("Driving route normalization failed.");
  let providerFailure = false;
  try { await suggestDeliveryAddresses("12", "test-session-token-123456", { env, fetcher: (async () => new Response("failed", { status: 503 })) as typeof fetch }); } catch { providerFailure = true; }
  if (!providerFailure) throw new Error("Provider failure was not surfaced.");
  console.log(JSON.stringify({ inputNormalization: true, shortInput: true, providerFailure: true, providerResponseNormalization: true, selectedAddressValidation: true, changedAddressInvalidatesValidation: true, deliveryGuard: true, pickupWithoutAddress: true, dineInWithoutAddress: true, apiKeyNotExposed: true, drivingRoute: true }, null, 2));
}
main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });

import { createHmac, timingSafeEqual } from "node:crypto";
import { assertConfigured } from "@/lib/config";

export type AddressSuggestion = {
  id: string;
  text: string;
  mainText: string;
  secondaryText: string;
  provider: "google";
};
export type ValidatedDeliveryAddress = {
  enteredAddress: string;
  formattedAddress: string;
  line1: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  latitude: number;
  longitude: number;
  provider: "google";
  providerReferenceId: string;
  validatedAt: string;
};

type AddressEnvironment = NodeJS.ProcessEnv;
type Fetcher = typeof fetch;

export function normalizeAddressInput(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

export function addressProviderStatus(env: AddressEnvironment = process.env) {
  const provider = env.ADDRESS_PROVIDER?.trim().toLowerCase() || "";
  return {
    provider,
    configured:
      provider === "google" && Boolean(env.GOOGLE_MAPS_API_KEY?.trim()),
  };
}

function googleConfiguration(env: AddressEnvironment) {
  const status = addressProviderStatus(env);
  if (!status.configured)
    throw new Error(
      "Delivery address validation is unavailable. Configure the address provider before submitting Delivery orders.",
    );
  const latitude = Number(env.DELI_ORIGIN_LATITUDE);
  const longitude = Number(env.DELI_ORIGIN_LONGITUDE);
  const configuredRadius = Number(env.DELI_DELIVERY_RADIUS_MILES || 12);
  return {
    key: env.GOOGLE_MAPS_API_KEY!.trim(),
    bias:
      Number.isFinite(latitude) && Number.isFinite(longitude)
        ? { latitude, longitude }
        : null,
    radiusMiles:
      Number.isFinite(configuredRadius) && configuredRadius > 0
        ? Math.min(configuredRadius, 50)
        : 12,
  };
}

async function googleJson(
  url: string,
  body: unknown,
  key: string,
  fieldMask: string | null,
  fetcher: Fetcher,
) {
  const response = await fetcher(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Goog-Api-Key": key,
      ...(fieldMask ? { "X-Goog-FieldMask": fieldMask } : {}),
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!response.ok)
    throw new Error("The address provider could not complete this request.");
  return response.json() as Promise<Record<string, any>>;
}

export async function suggestDeliveryAddresses(
  input: string,
  sessionToken: string,
  options: { env?: AddressEnvironment; fetcher?: Fetcher } = {},
): Promise<AddressSuggestion[]> {
  const normalized = normalizeAddressInput(input);
  if (normalized.length < 2) return [];
  const env = options.env || process.env;
  const config = googleConfiguration(env);
  const body: Record<string, unknown> = {
    input: normalized,
    sessionToken,
    includedRegionCodes: ["us"],
    languageCode: "en-US",
    regionCode: "us",
  };
  if (config.bias)
    body.locationRestriction = {
      circle: { center: config.bias, radius: config.radiusMiles * 1609.344 },
    };
  const payload = await googleJson(
    "https://places.googleapis.com/v1/places:autocomplete",
    body,
    config.key,
    "suggestions.placePrediction.placeId,suggestions.placePrediction.text.text,suggestions.placePrediction.structuredFormat.mainText.text,suggestions.placePrediction.structuredFormat.secondaryText.text",
    options.fetcher || fetch,
  );
  return (Array.isArray(payload.suggestions) ? payload.suggestions : [])
    .flatMap((entry: any) => {
      const prediction = entry?.placePrediction;
      if (!prediction?.placeId || !prediction?.text?.text) return [];
      return [
        {
          id: String(prediction.placeId),
          text: String(prediction.text.text),
          mainText: String(
            prediction.structuredFormat?.mainText?.text || prediction.text.text,
          ),
          secondaryText: String(
            prediction.structuredFormat?.secondaryText?.text || "",
          ),
          provider: "google" as const,
        },
      ];
    })
    .slice(0, 6);
}

export async function validateDeliveryAddress(
  input: { enteredAddress: string; placeId?: string; sessionToken: string },
  options: { env?: AddressEnvironment; fetcher?: Fetcher } = {},
): Promise<ValidatedDeliveryAddress> {
  const enteredAddress = normalizeAddressInput(input.enteredAddress);
  if (enteredAddress.length < 5)
    throw new Error("Enter a complete street address.");
  const env = options.env || process.env;
  const config = googleConfiguration(env);
  if (input.placeId) {
    const response = await (options.fetcher || fetch)(
      `https://places.googleapis.com/v1/places/${encodeURIComponent(input.placeId)}`,
      {
        headers: {
          "X-Goog-Api-Key": config.key,
          "X-Goog-FieldMask": "id,formattedAddress,postalAddress,location",
        },
        cache: "no-store",
      },
    );
    if (!response.ok)
      throw new Error("The selected delivery location could not be verified.");
    const place = (await response.json()) as Record<string, any>;
    const postal = place.postalAddress || {},
      location = place.location || {};
    const line1 = Array.isArray(postal.addressLines)
      ? String(postal.addressLines[0] || "")
      : "";
    if (
      !line1 ||
      !postal.locality ||
      !postal.administrativeArea ||
      !postal.postalCode ||
      !Number.isFinite(Number(location.latitude)) ||
      !Number.isFinite(Number(location.longitude))
    ) {
      throw new Error(
        "This location does not have a complete delivery address. Enter the street address instead.",
      );
    }
    return {
      enteredAddress,
      formattedAddress: String(
        place.formattedAddress ||
          [
            line1,
            postal.locality,
            postal.administrativeArea,
            postal.postalCode,
          ].join(", "),
      ),
      line1,
      city: String(postal.locality),
      state: String(postal.administrativeArea),
      postalCode: String(postal.postalCode),
      country: String(postal.regionCode || "US"),
      latitude: Number(location.latitude),
      longitude: Number(location.longitude),
      provider: "google",
      providerReferenceId: String(place.id || input.placeId),
      validatedAt: new Date().toISOString(),
    };
  }
  const payload = await googleJson(
    "https://addressvalidation.googleapis.com/v1:validateAddress",
    {
      address: { addressLines: [enteredAddress], regionCode: "US" },
      sessionToken: input.sessionToken,
    },
    config.key,
    null,
    options.fetcher || fetch,
  );
  const result = payload.result || {};
  const address = result.address || {};
  const postal = address.postalAddress || {};
  const verdict = result.verdict || {};
  const location = result.geocode?.location || {};
  const line1 = Array.isArray(postal.addressLines)
    ? String(postal.addressLines[0] || "")
    : "";
  const complete =
    verdict.addressComplete === true &&
    ["PREMISE", "SUB_PREMISE"].includes(
      String(verdict.validationGranularity || ""),
    );
  if (
    !complete ||
    !line1 ||
    !postal.locality ||
    !postal.administrativeArea ||
    !postal.postalCode ||
    !Number.isFinite(Number(location.latitude)) ||
    !Number.isFinite(Number(location.longitude))
  ) {
    throw new Error(
      "This address is incomplete or ambiguous. Check the street, city, state, and ZIP code.",
    );
  }
  return {
    enteredAddress,
    formattedAddress: String(
      address.formattedAddress ||
        [line1, postal.locality, postal.administrativeArea, postal.postalCode]
          .filter(Boolean)
          .join(", "),
    ),
    line1,
    city: String(postal.locality),
    state: String(postal.administrativeArea),
    postalCode: String(postal.postalCode),
    country: String(postal.regionCode || "US"),
    latitude: Number(location.latitude),
    longitude: Number(location.longitude),
    provider: "google",
    providerReferenceId: String(input.placeId || ""),
    validatedAt: new Date().toISOString(),
  };
}

function tokenSecret(): string {
  assertConfigured("SESSION_SECRET");
  return process.env.SESSION_SECRET!.trim();
}
export function createAddressValidationToken(
  address: ValidatedDeliveryAddress,
): string {
  const encoded = Buffer.from(
    JSON.stringify({ address, exp: Date.now() + 30 * 60_000 }),
  ).toString("base64url");
  return `${encoded}.${createHmac("sha256", tokenSecret()).update(encoded).digest("base64url")}`;
}

export function readAddressValidationToken(
  token: string,
  enteredAddress: string,
): ValidatedDeliveryAddress | null {
  try {
    const [encoded, signature] = token.split(".");
    if (!encoded || !signature) return null;
    const expected = createHmac("sha256", tokenSecret())
      .update(encoded)
      .digest();
    const actual = Buffer.from(signature, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      return null;
    const payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as { address: ValidatedDeliveryAddress; exp: number };
    if (
      payload.exp < Date.now() ||
      normalizeAddressInput(enteredAddress) !== payload.address.enteredAddress
    )
      return null;
    return payload.address;
  } catch {
    return null;
  }
}

export function addressForOrder(
  serviceType: string,
  token: string,
  enteredAddress: string,
): ValidatedDeliveryAddress | null {
  if (serviceType !== "delivery") return null;
  const address = readAddressValidationToken(token, enteredAddress);
  if (!address)
    throw new Error(
      "Validate the delivery address before saving this Delivery order.",
    );
  return address;
}

export async function routeDeliveryAddress(
  address: ValidatedDeliveryAddress,
  options: { env?: AddressEnvironment; fetcher?: Fetcher } = {},
) {
  const env = options.env || process.env;
  const config = googleConfiguration(env);
  if (!config.bias)
    throw new Error(
      "Corner Deli origin coordinates are not configured for driving distance.",
    );
  const payload = await googleJson(
    "https://routes.googleapis.com/directions/v2:computeRoutes",
    {
      origin: { location: { latLng: config.bias } },
      destination: {
        location: {
          latLng: { latitude: address.latitude, longitude: address.longitude },
        },
      },
      travelMode: "DRIVE",
      routingPreference: "TRAFFIC_AWARE",
    },
    config.key,
    "routes.distanceMeters,routes.duration",
    options.fetcher || fetch,
  );
  const route = Array.isArray(payload.routes) ? payload.routes[0] : null;
  if (!route) throw new Error("No driving route was found for this address.");
  const distanceMiles = Number(route.distanceMeters) / 1609.344;
  if (distanceMiles > config.radiusMiles)
    throw new Error(
      `Delivery address is outside the ${config.radiusMiles}-mile delivery area.`,
    );
  return {
    distanceMiles,
    durationSeconds: Number(String(route.duration || "0s").replace(/s$/, "")),
    provider: "google" as const,
    calculatedAt: new Date().toISOString(),
  };
}

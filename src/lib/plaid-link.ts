import type { Business } from "@/lib/types";

const PLAID_PRODUCTS = ["transactions"];
const CANONICAL_OAUTH_REDIRECT = "https://corner-ops.vercel.app/ops/integrations";

type PlaidErrorPayload = {
  error_code?: string;
  error_message?: string;
  display_message?: string | null;
  request_id?: string;
};

type PlaidLinkTokenPayload = {
  link_token: string;
  expiration: string;
};

function clean(value: unknown, max = 500): string {
  return String(value ?? "").trim().slice(0, max);
}

function plaidEnvironment(): "sandbox" | "production" {
  return process.env.PLAID_ENV?.toLowerCase() === "production" ? "production" : "sandbox";
}

function plaidBase(): string {
  return plaidEnvironment() === "production" ? "https://production.plaid.com" : "https://sandbox.plaid.com";
}

function allowedOrigin(origin: string): string {
  const url = new URL(origin);
  if (url.protocol !== "https:" && url.hostname !== "localhost") {
    throw new Error("The Plaid connection page requires HTTPS.");
  }
  return url.origin;
}

function validRedirectUri(value: string | undefined): string | null {
  const configured = value?.trim();
  if (!configured) return null;
  try {
    const url = new URL(configured);
    if (url.protocol !== "https:" && url.hostname !== "localhost") return null;
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function isRedirectConfigurationError(payload: PlaidErrorPayload): boolean {
  const text = `${payload.error_code || ""} ${payload.error_message || ""} ${payload.display_message || ""}`.toLowerCase();
  return text.includes("redirect uri") || text.includes("redirect_uri") || text.includes("oauth redirect");
}

async function requestLinkToken(body: Record<string, unknown>): Promise<{
  ok: true;
  payload: PlaidLinkTokenPayload;
} | {
  ok: false;
  status: number;
  payload: PlaidErrorPayload;
}> {
  const clientId = process.env.PLAID_CLIENT_ID?.trim();
  const secret = process.env.PLAID_SECRET?.trim();
  if (!clientId || !secret) throw new Error("Plaid credentials are not configured.");

  const response = await fetch(`${plaidBase()}/link/token/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, secret, ...body }),
    cache: "no-store",
  });
  const payload = await response.json().catch(() => ({})) as PlaidLinkTokenPayload & PlaidErrorPayload;
  if (response.ok && payload.link_token) return { ok: true, payload };
  return { ok: false, status: response.status, payload };
}

export async function createResilientPlaidLinkToken(input: { business: Business; origin: string }) {
  const origin = allowedOrigin(input.origin);
  const redirectUri = validRedirectUri(process.env.PLAID_REDIRECT_URI)
    || (origin.includes("localhost") ? `${origin}/ops/integrations` : CANONICAL_OAUTH_REDIRECT);
  const baseRequest: Record<string, unknown> = {
    client_name: "Corner Ops",
    language: "en",
    country_codes: ["US"],
    products: PLAID_PRODUCTS,
    transactions: { days_requested: 730 },
    user: {
      client_user_id: `corner-ops-${input.business.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    },
  };

  let result = await requestLinkToken({ ...baseRequest, redirect_uri: redirectUri });
  let oauthEnabled = true;
  let oauthWarning = "";

  if (!result.ok && isRedirectConfigurationError(result.payload)) {
    console.warn("[plaid-link] OAuth redirect was rejected; retrying without redirect", {
      redirectUri,
      errorCode: result.payload.error_code || "",
      requestId: result.payload.request_id || "",
    });
    result = await requestLinkToken(baseRequest);
    oauthEnabled = false;
    oauthWarning = `OAuth-only institutions require registering ${redirectUri} in the Plaid dashboard. Standard institutions remain available.`;
  }

  if (!result.ok) {
    const message = clean(
      result.payload.display_message
      || result.payload.error_message
      || `Plaid link-token request failed (${result.status}).`,
    );
    console.error("[plaid-link] token creation failed", {
      status: result.status,
      errorCode: result.payload.error_code || "",
      requestId: result.payload.request_id || "",
      message,
    });
    throw new Error(message || "Plaid could not start the bank connection.");
  }

  return {
    linkToken: result.payload.link_token,
    expiration: result.payload.expiration,
    environment: plaidEnvironment(),
    oauthEnabled,
    oauthRedirectUri: oauthEnabled ? redirectUri : null,
    oauthCallbackToRegister: redirectUri,
    oauthWarning,
  };
}

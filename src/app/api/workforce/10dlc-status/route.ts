import { canAccessBusiness, getSession } from "@/lib/auth";
import { unauthorized } from "@/lib/http";
import { normalizeSmsPhone } from "@/lib/phone";
import type { Business } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type JsonRecord = Record<string, unknown>;

function configuration() {
  const apiKey = process.env.TELNYX_API_KEY?.trim();
  const from = process.env.TELNYX_FROM_NUMBER?.trim();
  return apiKey && from ? { apiKey, from: normalizeSmsPhone(from) } : null;
}

function recordsFrom(value: unknown): JsonRecord[] {
  if (!value || typeof value !== "object") return [];
  const object = value as JsonRecord;
  for (const key of ["records", "data"]) {
    const candidate = object[key];
    if (Array.isArray(candidate)) {
      return candidate.filter((item): item is JsonRecord => Boolean(item) && typeof item === "object" && !Array.isArray(item));
    }
  }
  return [];
}

function stringValue(record: JsonRecord, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return "";
}

async function telnyxFetch(path: string, apiKey: string, allowNotFound = false): Promise<{ ok: boolean; status: number; body: unknown; error: string }> {
  const response = await fetch(`https://api.telnyx.com/v2${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    cache: "no-store",
  });
  const body = await response.json().catch(() => null) as unknown;
  if (response.ok) return { ok: true, status: response.status, body, error: "" };
  if (allowNotFound && response.status === 404) return { ok: false, status: 404, body, error: "" };

  const object = body && typeof body === "object" ? body as JsonRecord : {};
  const errors = Array.isArray(object.errors) ? object.errors as JsonRecord[] : [];
  const first = errors[0] || {};
  const error = stringValue(first, "detail", "title") || `Telnyx request failed (${response.status}).`;
  return { ok: false, status: response.status, body, error };
}

function uniqueByCampaignId(records: JsonRecord[]): JsonRecord[] {
  const seen = new Set<string>();
  return records.filter((record) => {
    const id = stringValue(record, "campaignId", "id", "telnyxCampaignId");
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export async function GET() {
  try {
    const session = await getSession();
    if (!session) return unauthorized();

    const business: Business = "Corner Deli";
    if (!canAccessBusiness(session, business)) {
      return Response.json({ error: "Business access denied." }, { status: 403 });
    }

    const configured = configuration();
    if (!configured) {
      return Response.json({
        configured: false,
        error: "TELNYX_API_KEY and TELNYX_FROM_NUMBER must both be configured.",
      }, { status: 503 });
    }

    const brandResponse = await telnyxFetch("/10dlc/brand?recordsPerPage=100", configured.apiKey);
    const builderResponse = await telnyxFetch("/10dlc/campaignBuilder?page[size]=100", configured.apiKey);

    const brands = recordsFrom(brandResponse.body);
    const campaignRecords: JsonRecord[] = [...recordsFrom(builderResponse.body)];
    const campaignErrors: string[] = [];

    for (const brand of brands) {
      const brandId = stringValue(brand, "brandId", "id");
      if (!brandId) continue;
      const response = await telnyxFetch(`/10dlc/campaign?brandId=${encodeURIComponent(brandId)}&recordsPerPage=100`, configured.apiKey);
      if (response.ok) campaignRecords.push(...recordsFrom(response.body));
      else campaignErrors.push(`${stringValue(brand, "displayName", "companyName") || brandId}: ${response.error}`);
    }

    const campaigns = uniqueByCampaignId(campaignRecords);
    const campaignDiagnostics = await Promise.all(campaigns.map(async (campaign) => {
      const campaignId = stringValue(campaign, "campaignId", "id", "telnyxCampaignId");
      let operationStatus: unknown = null;
      let operationStatusError = "";
      if (campaignId) {
        const operation = await telnyxFetch(`/10dlc/campaign/${encodeURIComponent(campaignId)}/operationStatus`, configured.apiKey);
        if (operation.ok) operationStatus = operation.body;
        else operationStatusError = operation.error;
      }

      return {
        campaignId,
        tcrCampaignId: stringValue(campaign, "tcrCampaignId"),
        brandId: stringValue(campaign, "brandId"),
        tcrBrandId: stringValue(campaign, "tcrBrandId"),
        brandDisplayName: stringValue(campaign, "brandDisplayName", "displayName"),
        status: stringValue(campaign, "status", "campaignStatus"),
        usecase: stringValue(campaign, "usecase", "useCase"),
        description: stringValue(campaign, "description"),
        createDate: stringValue(campaign, "createDate", "createdAt"),
        billedDate: stringValue(campaign, "billedDate"),
        failureReasons: stringValue(campaign, "failureReasons"),
        operationStatus,
        operationStatusError,
      };
    }));

    const assignmentResponse = await telnyxFetch(
      `/10dlc/phone_number_campaigns/${encodeURIComponent(configured.from)}`,
      configured.apiKey,
      true,
    );
    const assignmentBody = assignmentResponse.body && typeof assignmentResponse.body === "object"
      ? assignmentResponse.body as JsonRecord
      : {};
    const assignmentRecord = assignmentBody.data && typeof assignmentBody.data === "object" && !Array.isArray(assignmentBody.data)
      ? assignmentBody.data as JsonRecord
      : assignmentBody;

    return Response.json({
      configured: true,
      checkedAt: new Date().toISOString(),
      sendingNumber: configured.from,
      brands: brands.map((brand) => ({
        brandId: stringValue(brand, "brandId", "id"),
        tcrBrandId: stringValue(brand, "tcrBrandId"),
        displayName: stringValue(brand, "displayName", "companyName"),
        companyName: stringValue(brand, "companyName"),
        identityStatus: stringValue(brand, "identityStatus"),
        status: stringValue(brand, "status"),
        failureReasons: stringValue(brand, "failureReasons"),
        assignedCampaignsCount: stringValue(brand, "assignedCampaingsCount", "assignedCampaignsCount"),
      })),
      campaigns: campaignDiagnostics,
      numberAssignment: assignmentResponse.ok ? {
        found: true,
        phoneNumber: stringValue(assignmentRecord, "phoneNumber") || configured.from,
        campaignId: stringValue(assignmentRecord, "campaignId", "telnyxCampaignId"),
        telnyxCampaignId: stringValue(assignmentRecord, "telnyxCampaignId"),
        tcrCampaignId: stringValue(assignmentRecord, "tcrCampaignId"),
        brandId: stringValue(assignmentRecord, "brandId"),
        tcrBrandId: stringValue(assignmentRecord, "tcrBrandId"),
        assignmentStatus: stringValue(assignmentRecord, "assignmentStatus", "status"),
        failureReasons: stringValue(assignmentRecord, "failureReasons"),
      } : {
        found: false,
        phoneNumber: configured.from,
        campaignId: "",
        telnyxCampaignId: "",
        tcrCampaignId: "",
        brandId: "",
        tcrBrandId: "",
        assignmentStatus: assignmentResponse.status === 404 ? "NOT_ASSIGNED" : "CHECK_FAILED",
        failureReasons: assignmentResponse.error,
      },
      diagnostics: {
        brandRequestError: brandResponse.ok ? "" : brandResponse.error,
        campaignBuilderRequestError: builderResponse.ok ? "" : builderResponse.error,
        campaignRequestErrors: campaignErrors,
      },
    });
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : "Unable to check Telnyx 10DLC status.",
    }, { status: 500 });
  }
}

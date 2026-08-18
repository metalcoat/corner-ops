import { normalizeSmsPhone } from "@/lib/phone";

export type SmsRecipient = {
  id: string;
  name: string;
  phone: string;
  smsOptIn: boolean;
};

type SmsFailure = {
  employeeId: string;
  message: string;
};

type SmsAccepted = {
  employeeId: string;
  messageId: string;
  status: string;
};

type TelnyxMessagePayload = {
  id?: string;
  to?: Array<{ status?: string; phone_number?: string }>;
  errors?: Array<{ code?: string; title?: string; detail?: string }>;
};

function configuration() {
  const apiKey = process.env.TELNYX_API_KEY?.trim();
  const from = process.env.TELNYX_FROM_NUMBER?.trim();
  return apiKey && from ? { apiKey, from: normalizeSmsPhone(from) } : null;
}

export async function getSmsDeliveryStatus(messageId: string) {
  const configured = configuration();
  if (!configured) throw new Error("Telnyx SMS is not configured.");
  const cleanId = String(messageId || "").trim();
  if (!cleanId) throw new Error("Missing Telnyx message ID.");

  const response = await fetch(`https://api.telnyx.com/v2/messages/${encodeURIComponent(cleanId)}`, {
    headers: { Authorization: `Bearer ${configured.apiKey}` },
    cache: "no-store",
  });
  const payload = await response.json().catch(() => null) as { data?: TelnyxMessagePayload; errors?: Array<{ code?: string; title?: string; detail?: string }> } | null;
  if (!response.ok) {
    const detail = payload?.errors?.[0]?.detail || payload?.errors?.[0]?.title || `Telnyx status request failed (${response.status}).`;
    throw new Error(detail);
  }

  const data = payload?.data || {};
  return {
    messageId: data.id || cleanId,
    status: data.to?.[0]?.status || "unknown",
    errors: (data.errors || []).map((error) => ({
      code: error.code || "",
      title: error.title || "",
      detail: error.detail || "",
    })),
  };
}

export async function deliverSms(input: {
  recipients: SmsRecipient[];
  text: (employee: SmsRecipient) => string;
}) {
  const configured = configuration();
  const optedIn = input.recipients.filter((employee) => employee.smsOptIn);
  const deliverable: Array<SmsRecipient & { normalizedPhone: string }> = [];
  const failures: SmsFailure[] = [];
  const accepted: SmsAccepted[] = [];
  let missingPhone = 0;

  for (const employee of optedIn) {
    try {
      const normalizedPhone = normalizeSmsPhone(employee.phone);
      if (!normalizedPhone) {
        missingPhone += 1;
        continue;
      }
      deliverable.push({ ...employee, normalizedPhone });
    } catch (error) {
      failures.push({
        employeeId: employee.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (!configured) {
    return {
      provider: "telnyx" as const,
      configured: false,
      sent: 0,
      failed: failures.length,
      missingPhone,
      notOptedIn: input.recipients.length - optedIn.length,
      skipped: deliverable.length,
      failures,
      accepted,
    };
  }

  let sent = 0;
  for (const employee of deliverable) {
    try {
      const response = await fetch("https://api.telnyx.com/v2/messages", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${configured.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: configured.from,
          to: employee.normalizedPhone,
          text: input.text(employee).trim().slice(0, 600),
          type: "SMS",
        }),
      });
      const payload = await response.json().catch(() => null) as { data?: TelnyxMessagePayload; errors?: Array<{ detail?: string; title?: string }> } | null;
      if (!response.ok) {
        const detail = payload?.errors?.[0]?.detail || payload?.errors?.[0]?.title || `Telnyx request failed (${response.status}).`;
        throw new Error(detail);
      }
      sent += 1;
      accepted.push({
        employeeId: employee.id,
        messageId: payload?.data?.id || "",
        status: payload?.data?.to?.[0]?.status || "accepted",
      });
    } catch (error) {
      failures.push({
        employeeId: employee.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    provider: "telnyx" as const,
    configured: true,
    sent,
    failed: failures.length,
    missingPhone,
    notOptedIn: input.recipients.length - optedIn.length,
    skipped: 0,
    failures,
    accepted,
  };
}

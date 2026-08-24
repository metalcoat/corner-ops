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

const SMS_CONCURRENCY = 6;
function configuration() {
  const apiKey = process.env.TELNYX_API_KEY?.trim();
  const from = process.env.TELNYX_FROM_NUMBER?.trim();
  if (!apiKey || !from) return null;
  try {
    const normalizedFrom = normalizeSmsPhone(from);
    return normalizedFrom ? { apiKey, from: normalizedFrom } : null;
  } catch {
    return null;
  }
}

async function inBatches<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>) {
  for (let index = 0; index < items.length; index += concurrency) {
    await Promise.all(items.slice(index, index + concurrency).map(worker));
  }
}

export async function deliverSms(input: {
  recipients: SmsRecipient[];
  text: (employee: SmsRecipient) => string;
}) {
  const configured = configuration();
  const optedIn = input.recipients.filter((employee) => employee.smsOptIn);
  const deliverable: Array<SmsRecipient & { normalizedPhone: string }> = [];
  const failures: SmsFailure[] = [];
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
    };
  }

  let sent = 0;
  await inBatches(deliverable, SMS_CONCURRENCY, async (employee) => {
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
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { errors?: Array<{ detail?: string; title?: string }> } | null;
        const detail = payload?.errors?.[0]?.detail || payload?.errors?.[0]?.title || `Telnyx request failed (${response.status}).`;
        throw new Error(detail);
      }
      sent += 1;
    } catch (error) {
      failures.push({
        employeeId: employee.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return {
    provider: "telnyx" as const,
    configured: true,
    sent,
    failed: failures.length,
    missingPhone,
    notOptedIn: input.recipients.length - optedIn.length,
    skipped: 0,
    failures,
  };
}

import { Resend } from "resend";

function clean(value: unknown, max = 500): string {
  return String(value ?? "").trim().slice(0, max);
}

export function cornerOpsBaseUrl(): string {
  const configured = process.env.APP_URL?.trim() || process.env.EMPLOYEE_APP_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim() || process.env.VERCEL_URL?.trim();
  return vercel ? `https://${vercel.replace(/\/$/, "")}` : "";
}

export function ownerNotificationEmails(): string[] {
  const values = [
    ...(process.env.ALERT_TO_EMAIL || "").split(/[;,]/),
    process.env.APP_EMAIL || "",
  ].map((value) => clean(value, 320).toLowerCase()).filter((value) => /^\S+@\S+\.\S+$/.test(value));
  return [...new Set(values)];
}

function configuration() {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.EMPLOYEE_NOTIFICATION_FROM_EMAIL?.trim() || process.env.ALERT_FROM_EMAIL?.trim();
  return apiKey && from ? { resend: new Resend(apiKey), from } : null;
}

export async function sendTransactionalEmail(input: {
  to: string | string[];
  subject: string;
  text: string;
}): Promise<{ configured: boolean; sent: number; failures: string[] }> {
  const recipients = (Array.isArray(input.to) ? input.to : [input.to])
    .map((value) => clean(value, 320).toLowerCase())
    .filter((value) => /^\S+@\S+\.\S+$/.test(value));
  const unique = [...new Set(recipients)];
  const configured = configuration();
  if (!configured) return { configured: false, sent: 0, failures: unique.map(() => "Outbound email is not configured.") };

  let sent = 0;
  const failures: string[] = [];
  for (const to of unique) {
    try {
      const result = await configured.resend.emails.send({
        from: configured.from,
        to,
        subject: clean(input.subject, 240),
        text: input.text,
      });
      if (result.error) throw new Error(result.error.message);
      sent += 1;
    } catch (error) {
      failures.push(`${to}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { configured: true, sent, failures };
}

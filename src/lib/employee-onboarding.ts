import { deliverSms } from "@/lib/sms-notifications";
import { cornerOpsBaseUrl } from "@/lib/transactional-email";
import type { Business } from "@/lib/types";

export type EmployeeOnboardingSmsInput = {
  id: string;
  business: Business;
  name: string;
  phone: string;
  smsOptIn: boolean;
  pin: string;
};

function firstName(value: string): string {
  return value.trim().split(/\s+/)[0] || "there";
}

export async function sendEmployeeOnboardingSms(input: EmployeeOnboardingSmsInput) {
  const baseUrl = cornerOpsBaseUrl();
  if (!baseUrl) {
    return {
      provider: "telnyx" as const,
      configured: false,
      sent: 0,
      failed: 1,
      missingPhone: 0,
      notOptedIn: input.smsOptIn ? 0 : 1,
      skipped: 0,
      failures: [{ employeeId: input.id, message: "APP_URL or EMPLOYEE_APP_URL is not configured." }],
      accepted: [],
    };
  }

  const employeeHubUrl = `${baseUrl}/employee?business=${encodeURIComponent(input.business)}`;
  const formsUrl = `${baseUrl}/employee/forms`;

  return deliverSms({
    recipients: [{ id: input.id, name: input.name, phone: input.phone, smsOptIn: input.smsOptIn }],
    text: () => [
      `${input.business}: Welcome, ${firstName(input.name)}!`,
      `Sign in to Corner Ops Employee Hub: ${employeeHubUrl}`,
      `Your PIN is ${input.pin}.`,
      `Complete your new-hire paperwork here after signing in: ${formsUrl}`,
      "Questions? Send a message in Corner Ops. Do not reply to this text; replies are not monitored.",
    ].join("\n"),
  });
}

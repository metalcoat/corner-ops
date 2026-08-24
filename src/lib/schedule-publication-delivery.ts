import { Resend } from "resend";
import { getSql } from "@/lib/db";

const CLAIM_STALE_MINUTES = 10;

type DeliveryRow = {
  id: string;
  publication_id: string;
  employee_id: string | null;
  destination: string;
  subject: string;
  body: string;
  idempotency_key: string;
  attempt_count: number;
};

function clean(value: unknown, max = 1000): string {
  return String(value ?? "").trim().slice(0, max);
}

function emailConfiguration() {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.EMPLOYEE_NOTIFICATION_FROM_EMAIL?.trim() || process.env.ALERT_FROM_EMAIL?.trim();
  return apiKey && from ? { resend: new Resend(apiKey), from } : null;
}

async function recoverStaleClaims() {
  await getSql()`
    UPDATE schedule_publication_deliveries
    SET status = 'Failed', last_error = CASE WHEN last_error = '' THEN 'Delivery worker was interrupted.' ELSE last_error END,
      next_attempt_at = NOW(), updated_at = NOW()
    WHERE status = 'Sending' AND updated_at < NOW() - (${CLAIM_STALE_MINUTES}::text || ' minutes')::interval
  `;
}

async function claimDelivery(publicationId?: string | null): Promise<DeliveryRow | null> {
  const rows = await getSql()`
    WITH candidate AS (
      SELECT id
      FROM schedule_publication_deliveries
      WHERE status IN ('Pending', 'Failed', 'Waiting Configuration')
        AND next_attempt_at <= NOW()
        AND (${publicationId || null}::uuid IS NULL OR publication_id = ${publicationId || null}::uuid)
      ORDER BY created_at, id
      LIMIT 1
    )
    UPDATE schedule_publication_deliveries delivery
    SET status = 'Sending', attempt_count = attempt_count + 1, updated_at = NOW()
    FROM candidate
    WHERE delivery.id = candidate.id
      AND delivery.status IN ('Pending', 'Failed', 'Waiting Configuration')
    RETURNING delivery.id, delivery.publication_id, delivery.employee_id, delivery.destination,
      delivery.subject, delivery.body, delivery.idempotency_key, delivery.attempt_count
  ` as unknown as DeliveryRow[];
  return rows[0] || null;
}

async function updatePublication(publicationId: string) {
  const configured = Boolean(emailConfiguration());
  const counts = await getSql()`
    SELECT
      COUNT(*) FILTER (WHERE status = 'Sent')::int AS sent,
      COUNT(*) FILTER (WHERE status = 'Failed')::int AS failed,
      COUNT(*) FILTER (WHERE status = 'Waiting Configuration')::int AS waiting_configuration,
      COUNT(*) FILTER (WHERE status IN ('Pending', 'Sending'))::int AS pending
    FROM schedule_publication_deliveries
    WHERE publication_id = ${publicationId} AND channel = 'Email'
  ` as unknown as Array<{ sent: number; failed: number; waiting_configuration: number; pending: number }>;
  const row = counts[0] || { sent: 0, failed: 0, waiting_configuration: 0, pending: 0 };
  const incomplete = Number(row.pending || 0) > 0;
  const warnings = Number(row.failed || 0) > 0 || Number(row.waiting_configuration || 0) > 0 || !configured;
  const status = incomplete ? "Sending" : warnings ? "CompletedWithWarnings" : "Completed";
  await getSql()`
    UPDATE schedule_publications SET
      email_sent_count = ${Number(row.sent || 0)},
      email_failed_count = ${Number(row.failed || 0)},
      email_configured = ${configured},
      delivery_status = ${status},
      delivery_completed_at = CASE WHEN ${incomplete} THEN NULL ELSE NOW() END,
      details = details || jsonb_build_object(
        'emailQueuePending', ${Number(row.pending || 0)},
        'emailWaitingConfiguration', ${Number(row.waiting_configuration || 0)}
      )
    WHERE id = ${publicationId}
  `;
}

async function markWaiting(job: DeliveryRow, message: string) {
  await getSql()`
    UPDATE schedule_publication_deliveries
    SET status = 'Waiting Configuration', last_error = ${clean(message, 1000)},
      next_attempt_at = NOW() + INTERVAL '15 minutes', updated_at = NOW()
    WHERE id = ${job.id} AND status = 'Sending'
  `;
}

async function markFailure(job: DeliveryRow, error: unknown) {
  const attempt = Math.max(1, Number(job.attempt_count || 1));
  const delayMinutes = Math.min(60, 2 ** Math.min(5, attempt));
  await getSql()`
    UPDATE schedule_publication_deliveries
    SET status = 'Failed', last_error = ${clean(error instanceof Error ? error.message : error, 1000)},
      next_attempt_at = NOW() + (${delayMinutes}::text || ' minutes')::interval, updated_at = NOW()
    WHERE id = ${job.id} AND status = 'Sending'
  `;
}

async function markSent(job: DeliveryRow, providerId: string) {
  await getSql()`
    UPDATE schedule_publication_deliveries
    SET status = 'Sent', provider_id = ${clean(providerId, 300)}, last_error = '',
      sent_at = NOW(), updated_at = NOW()
    WHERE id = ${job.id} AND status = 'Sending'
  `;
}

async function deliver(job: DeliveryRow) {
  const configured = emailConfiguration();
  if (!configured) {
    await markWaiting(job, "Employee schedule email is not configured.");
    return;
  }
  if (!job.destination) {
    await markFailure(job, new Error("Schedule delivery has no email destination."));
    return;
  }
  try {
    const result = await configured.resend.emails.send({
      from: configured.from,
      to: job.destination,
      subject: job.subject,
      text: job.body,
    }, { idempotencyKey: job.idempotency_key });
    if (result.error) throw new Error(result.error.message);
    await markSent(job, result.data?.id || "");
  } catch (error) {
    await markFailure(job, error);
  }
}

export async function processSchedulePublicationDeliveries(input: { publicationId?: string | null; limit?: number } = {}) {
  await recoverStaleClaims();
  const limit = Math.max(1, Math.min(50, Number(input.limit || 20)));
  const touched = new Set<string>();
  let processed = 0;
  for (let index = 0; index < limit; index += 1) {
    const job = await claimDelivery(input.publicationId || null);
    if (!job) break;
    touched.add(job.publication_id);
    await deliver(job);
    processed += 1;
  }
  if (input.publicationId) touched.add(input.publicationId);
  for (const publicationId of touched) await updatePublication(publicationId);
  return { processed, publications: Array.from(touched) };
}

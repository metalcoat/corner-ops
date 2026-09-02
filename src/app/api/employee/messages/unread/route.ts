import { getEmployeeSession } from "@/lib/employee-auth";
import { getSql } from "@/lib/db";
import { apiError, unauthorized } from "@/lib/http";
import { ensureMessageReadSchema } from "@/lib/message-reads";
import { ensureWorkforceSchema } from "@/lib/workforce";

export const runtime = "nodejs";

export async function GET() {
  try {
    const session = await getEmployeeSession();
    if (!session) return unauthorized();

    await Promise.all([ensureWorkforceSchema(), ensureMessageReadSchema()]);
    const rows = await getSql()`
      SELECT m.id
      FROM employee_messages m
      WHERE m.business = ${session.business}
          AND m.deleted_at IS NULL
        AND (
          m.message_type IN ('Team', 'Announcement')
          OR m.sender_employee_id = ${session.employeeId}
          OR m.recipient_employee_id = ${session.employeeId}
        )
        AND m.sender_employee_id IS DISTINCT FROM ${session.employeeId}
        AND NOT EXISTS (
          SELECT 1
          FROM employee_message_reads r
          WHERE r.message_id = m.id
            AND r.employee_id = ${session.employeeId}
        )
      ORDER BY m.created_at DESC
      LIMIT 120
    ` as unknown as Array<{ id: string }>;

    return Response.json({ unreadMessageIds: rows.map((row) => String(row.id)) });
  } catch (error) {
    return apiError(error);
  }
}

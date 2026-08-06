import { getEmployeeSession } from "@/lib/employee-auth";
import { getSql } from "@/lib/db";
import { apiError, unauthorized } from "@/lib/http";
import { ensureMessageReadSchema } from "@/lib/message-reads";

export const runtime = "nodejs";

export async function GET() {
  try {
    const session = await getEmployeeSession();
    if (!session) return unauthorized();

    await ensureMessageReadSchema();
    const sql = getSql();
    const [latestRows, countRows] = await Promise.all([
      sql`
        SELECT m.id, m.sender_name, COALESCE(sender.chat_nickname, '') AS sender_chat_nickname,
          m.body, m.attachment_name, m.created_at
        FROM employee_messages m
        LEFT JOIN employees sender ON sender.id = m.sender_employee_id
        WHERE m.business = ${session.business}
          AND (
            m.message_type IN ('Team', 'Announcement')
            OR m.sender_employee_id = ${session.employeeId}
            OR m.recipient_employee_id = ${session.employeeId}
          )
        ORDER BY m.created_at DESC
        LIMIT 1
      `,
      sql`
        SELECT COUNT(*)::INTEGER AS unread_count
        FROM employee_messages m
        WHERE m.business = ${session.business}
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
      `,
    ]);

    const latest = (latestRows as unknown as Array<Record<string, unknown>>)[0];
    const unreadCount = Number((countRows as unknown as Array<{ unread_count: number | string }>)[0]?.unread_count || 0);

    return Response.json({
      unreadCount,
      latestMessageId: latest ? String(latest.id) : null,
      preview: latest ? {
        senderName: String(latest.sender_chat_nickname || latest.sender_name || ""),
        body: String(latest.body || ""),
        hasPhoto: Boolean(latest.attachment_name),
        createdAt: String(latest.created_at),
      } : null,
    }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return apiError(error);
  }
}

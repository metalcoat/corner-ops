import { getEmployeeSession } from "@/lib/employee-auth";
import { listDirectoryEmployees } from "@/lib/employee-directory-admin";
import { getSql } from "@/lib/db";
import { apiError, unauthorized } from "@/lib/http";
import { ensureMessageReadSchema } from "@/lib/message-reads";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const session = await getEmployeeSession();
    if (!session) return unauthorized();

    const requestedLimit = Number(new URL(request.url).searchParams.get("limit") || 80);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(120, Math.max(20, Math.round(requestedLimit)))
      : 80;

    await ensureMessageReadSchema();
    const sql = getSql();
    const [directory, messages, unreadRows] = await Promise.all([
      listDirectoryEmployees(session.business),
      sql`
        SELECT m.id, m.sender_employee_id, m.sender_name,
          COALESCE(sender.chat_nickname, '') AS sender_chat_nickname,
          COALESCE(sender.schedule_color, '#64748B') AS sender_schedule_color,
          COALESCE(sender.profile_photo_pathname <> '', FALSE) AS sender_avatar_set,
          recipient.name AS recipient_name, m.message_type, m.body,
          m.attachment_name, m.attachment_type, m.attachment_size, m.created_at
        FROM employee_messages m
        LEFT JOIN employees sender ON sender.id = m.sender_employee_id
        LEFT JOIN employees recipient ON recipient.id = m.recipient_employee_id
        WHERE m.business = ${session.business}
          AND (
            m.message_type IN ('Team', 'Announcement')
            OR m.sender_employee_id = ${session.employeeId}
            OR m.recipient_employee_id = ${session.employeeId}
          )
        ORDER BY m.created_at DESC
        LIMIT ${limit}
      `,
      sql`
        SELECT m.id
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
        ORDER BY m.created_at DESC
        LIMIT ${limit}
      `,
    ]);

    const activeDirectory = directory.filter((employee) => employee.active).map((employee) => ({
      id: employee.id,
      name: employee.name,
      position: employee.position,
      scheduleColor: employee.scheduleColor,
      avatarSet: employee.avatarSet,
      chatNickname: employee.chatNickname,
    }));
    const employee = activeDirectory.find((item) => item.id === session.employeeId);
    if (!employee) throw new Error("Employee is not active for this location.");

    return Response.json({
      employee,
      directory: activeDirectory,
      messages: (messages as unknown as Array<Record<string, unknown>>).map((message) => ({
        ...message,
        attachment_size: Number(message.attachment_size || 0),
      })),
      unreadMessageIds: (unreadRows as unknown as Array<{ id: string }>).map((row) => String(row.id)),
    }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return apiError(error);
  }
}

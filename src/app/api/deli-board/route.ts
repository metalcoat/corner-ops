import { canAccessBusiness, getSession } from "@/lib/auth";
import { getSql } from "@/lib/db";
import { verifyDeliBoardToken } from "@/lib/deli-board-auth";
import { getEmployeeSession } from "@/lib/employee-auth";
import { apiError, unauthorized } from "@/lib/http";
import { threeCxDeliCallReport } from "@/lib/three-cx-calls-report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BUSINESS = "Corner Deli" as const;
const CALL_FEED_TTL_MS = 60_000;
const CALL_FEED_ERROR_TTL_MS = 15_000;

type CallFeed = {
  workDate: string;
  calls: unknown[];
  callSummary: { unresolved: number; meaningful: number; issues: number; busy: number };
  callError: string;
  expiresAt: number;
};



function localDateKey(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function tomorrowDateKey(): string {
  return localDateKey(new Date(Date.now() + 24 * 60 * 60 * 1000));
}

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

async function boardActor(request: Request): Promise<{ name: string; access: "owner" | "employee" | "display" } | null> {
  const display = await verifyDeliBoardToken(bearerToken(request));
  if (display) return { name: "Deli Board", access: "display" };

  const owner = await getSession();
  if (owner && canAccessBusiness(owner, BUSINESS)) {
    return { name: owner.displayName, access: "owner" };
  }
  const employee = await getEmployeeSession();
  if (employee?.business === BUSINESS) {
    return { name: "Deli Board", access: "employee" };
  }
  return null;
}

async function loadCallFeed(today: string): Promise<CallFeed> {
  const sql = getSql();
  const cached = await sql`
    SELECT payload, expires_at
    FROM deli_board_call_cache
    WHERE work_date = ${today}::date AND expires_at > NOW()
  ` as unknown as Array<{ payload: Omit<CallFeed, "expiresAt">; expires_at: string }>;
  if (cached[0]?.payload) {
    return { ...cached[0].payload, expiresAt: new Date(cached[0].expires_at).getTime() };
  }

  try {
    const report = await threeCxDeliCallReport(today, tomorrowDateKey());
    const payload: Omit<CallFeed, "expiresAt"> = {
      workDate: today,
      calls: report.calls.filter((call) => !call.resolved).slice(0, 8),
      callSummary: {
        unresolved: Number(report.summary.unresolved || 0),
        meaningful: Number(report.summary.meaningful || 0),
        issues: Number(report.summary.issues || 0),
        busy: Number(report.summary.busy || 0),
      },
      callError: "",
    };
    await sql`
      INSERT INTO deli_board_call_cache (work_date, payload, expires_at, updated_at)
      VALUES (${today}::date, ${JSON.stringify(payload)}::jsonb,
        NOW() + (${CALL_FEED_TTL_MS} * INTERVAL '1 millisecond'), NOW())
      ON CONFLICT (work_date) DO UPDATE SET
        payload = EXCLUDED.payload,
        expires_at = EXCLUDED.expires_at,
        updated_at = NOW()
    `;
    return { ...payload, expiresAt: Date.now() + CALL_FEED_TTL_MS };
  } catch (error) {
    console.error("Deli board 3CX load failed", error);
    const payload: Omit<CallFeed, "expiresAt"> = {
      workDate: today,
      calls: [],
      callSummary: { unresolved: 0, meaningful: 0, issues: 0, busy: 0 },
      callError: "3CX call feed unavailable",
    };
    await sql`
      INSERT INTO deli_board_call_cache (work_date, payload, expires_at, updated_at)
      VALUES (${today}::date, ${JSON.stringify(payload)}::jsonb,
        NOW() + (${CALL_FEED_ERROR_TTL_MS} * INTERVAL '1 millisecond'), NOW())
      ON CONFLICT (work_date) DO UPDATE SET
        payload = EXCLUDED.payload,
        expires_at = EXCLUDED.expires_at,
        updated_at = NOW()
    `;
    return { ...payload, expiresAt: Date.now() + CALL_FEED_ERROR_TTL_MS };
  }
}

async function loadBoard() {
  const sql = getSql();
  const today = localDateKey();

  const [tasks, messages, schedule, callFeed] = await Promise.all([
    sql`
      SELECT t.id, t.title, t.category, t.sort_order,
        COALESCE(c.completed, FALSE) AS completed,
        c.completed_by, c.completed_at
      FROM deli_wallboard_tasks t
      LEFT JOIN deli_wallboard_task_checks c
        ON c.task_id = t.id AND c.work_date = ${today}::date
      WHERE t.active = TRUE
      ORDER BY COALESCE(c.completed, FALSE), t.sort_order, t.title
    `,
    sql`
      SELECT id, sender_name, message_type, body, created_at
      FROM employee_messages
      WHERE business = ${BUSINESS}
        AND recipient_employee_id IS NULL
        AND created_at >= NOW() - INTERVAL '3 days'
      ORDER BY created_at DESC
      LIMIT 10
    `,
    sql`
      SELECT s.id, e.name AS employee_name, s.position, s.starts_at, s.ends_at, s.status
      FROM schedule_shifts s
      JOIN employees e ON e.id = s.employee_id
      WHERE s.business = ${BUSINESS}
        AND s.employee_id IS NOT NULL
        AND s.status <> 'Cancelled'
        AND s.ends_at > NOW() - INTERVAL '2 hours'
        AND s.starts_at < NOW() + INTERVAL '12 hours'
      ORDER BY s.starts_at
      LIMIT 20
    `,
    loadCallFeed(today),
  ]);

  const taskRows = tasks as unknown as Array<Record<string, unknown>>;
  const completed = taskRows.filter((task) => Boolean(task.completed)).length;

  return {
    business: BUSINESS,
    generatedAt: new Date().toISOString(),
    workDate: today,
    tasks: taskRows,
    taskSummary: { total: taskRows.length, completed, remaining: taskRows.length - completed },
    messages,
    schedule,
    calls: callFeed.calls,
    callSummary: callFeed.callSummary,
    callError: callFeed.callError,
  };
}

export async function GET(request: Request) {
  try {
    const actor = await boardActor(request);
    if (!actor) return unauthorized();
    return Response.json({ ...(await loadBoard()), boardAccess: actor.access });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const actor = await boardActor(request);
    if (!actor) return unauthorized();

    const body = await request.json() as Record<string, unknown>;
    const action = String(body.action || "");
    const sql = getSql();
    const today = localDateKey();

    if (action === "toggle-task") {
      const taskId = String(body.taskId || "");
      const completed = body.completed === true;
      const existing = await sql`SELECT id FROM deli_wallboard_tasks WHERE id = ${taskId} AND active = TRUE LIMIT 1` as unknown as Array<{ id: string }>;
      if (!existing[0]) return Response.json({ error: "Task not found." }, { status: 404 });
      await sql`
        INSERT INTO deli_wallboard_task_checks (task_id, work_date, completed, completed_by, completed_at)
        VALUES (${taskId}, ${today}::date, ${completed}, ${actor.name}, ${completed ? new Date().toISOString() : null})
        ON CONFLICT (task_id, work_date) DO UPDATE SET
          completed = EXCLUDED.completed,
          completed_by = EXCLUDED.completed_by,
          completed_at = EXCLUDED.completed_at
      `;
      return Response.json({ ...(await loadBoard()), boardAccess: actor.access });
    }

    if (action === "add-task") {
      const title = String(body.title || "").trim().slice(0, 180);
      const category = String(body.category || "Today").trim().slice(0, 60) || "Today";
      if (!title) return Response.json({ error: "Enter a task." }, { status: 400 });
      const maxRows = await sql`SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM deli_wallboard_tasks` as unknown as Array<{ max_order: number | string }>;
      await sql`
        INSERT INTO deli_wallboard_tasks (id, title, category, sort_order, created_by)
        VALUES (${crypto.randomUUID()}, ${title}, ${category}, ${Number(maxRows[0]?.max_order || 0) + 1}, ${actor.name})
        ON CONFLICT (title) DO UPDATE SET active = TRUE, updated_at = NOW()
      `;
      return Response.json({ ...(await loadBoard()), boardAccess: actor.access });
    }

    return Response.json({ error: "Unknown deli board action." }, { status: 400 });
  } catch (error) {
    return apiError(error);
  }
}

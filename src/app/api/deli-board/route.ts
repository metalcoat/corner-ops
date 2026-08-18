import { canAccessBusiness, getSession } from "@/lib/auth";
import { getSql } from "@/lib/db";
import { getEmployeeSession } from "@/lib/employee-auth";
import { apiError, unauthorized } from "@/lib/http";
import { correctThreeCxCallReport } from "@/lib/three-cx-time-correction";
import { threeCxDeliCallReport } from "@/lib/three-cx-calls-report";
import { ensureWorkforceSchema } from "@/lib/workforce";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BUSINESS = "Corner Deli" as const;
let boardSchemaPromise: Promise<void> | null = null;

const DEFAULT_TASKS = [
  ["Prep", "Make sub rolls"],
  ["Prep", "Make hamburger buns"],
  ["Prep", "Thaw meats for antipasta"],
  ["Prep", "Thaw pizza sausage"],
  ["Prep", "Thaw ground beef"],
  ["Prep", "Portion chili"],
  ["Prep", "Prepare nacho cheese / chips"],
  ["Line", "Fill wing sauce bottles"],
  ["Line", "Fill pizza prep table"],
  ["Line", "Fill dressing bottles"],
  ["Produce", "Prep sub tomatoes"],
  ["Produce", "Julienne tomatoes"],
  ["Produce", "Prep salad vegetables"],
  ["Produce", "Prep celery for wings"],
  ["Produce", "Prep salad lettuce"],
  ["Stock", "Check olives"],
  ["Stock", "Cook / stock bacon"],
  ["Salads", "Check and stir front salads"],
  ["Salads", "Boil macaroni"],
  ["Salads", "Boil pasta"],
  ["Salads", "Prepare antipasta"],
  ["Salads", "Prepare coleslaw"],
  ["Sides", "Prepare brown beans"],
  ["Sides", "Prepare green beans"],
  ["Cleaning", "Clean steam table"],
  ["Cleaning", "Empty freezer tray / cooler water"],
] as const;

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

async function boardActor(): Promise<{ name: string; access: "owner" | "employee" } | null> {
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

async function ensureBoardSchema() {
  if (!boardSchemaPromise) {
    boardSchemaPromise = (async () => {
      await ensureWorkforceSchema();
      const sql = getSql();
      await sql`
        CREATE TABLE IF NOT EXISTS deli_wallboard_tasks (
          id UUID PRIMARY KEY,
          title TEXT NOT NULL UNIQUE,
          category TEXT NOT NULL DEFAULT 'Daily',
          sort_order INTEGER NOT NULL DEFAULT 0,
          active BOOLEAN NOT NULL DEFAULT TRUE,
          created_by TEXT NOT NULL DEFAULT 'System',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS deli_wallboard_task_checks (
          task_id UUID NOT NULL REFERENCES deli_wallboard_tasks(id) ON DELETE CASCADE,
          work_date DATE NOT NULL,
          completed BOOLEAN NOT NULL DEFAULT TRUE,
          completed_by TEXT NOT NULL DEFAULT '',
          completed_at TIMESTAMPTZ,
          PRIMARY KEY (task_id, work_date)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS deli_wallboard_checks_date_idx ON deli_wallboard_task_checks (work_date, completed)`;

      for (let index = 0; index < DEFAULT_TASKS.length; index += 1) {
        const [category, title] = DEFAULT_TASKS[index];
        await sql`
          INSERT INTO deli_wallboard_tasks (id, title, category, sort_order, created_by)
          VALUES (${crypto.randomUUID()}, ${title}, ${category}, ${index + 1}, 'System')
          ON CONFLICT (title) DO NOTHING
        `;
      }
    })().catch((error) => {
      boardSchemaPromise = null;
      throw error;
    });
  }
  return boardSchemaPromise;
}

async function loadBoard() {
  await ensureBoardSchema();
  const sql = getSql();
  const today = localDateKey();

  const [tasks, messages, schedule] = await Promise.all([
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
  ]);

  let calls: unknown[] = [];
  let callSummary = { unresolved: 0, meaningful: 0, issues: 0, busy: 0 };
  let callError = "";
  try {
    const report = correctThreeCxCallReport(await threeCxDeliCallReport(today, tomorrowDateKey()));
    const unresolved = report.calls.filter((call) => !call.resolved).slice(0, 8);
    calls = unresolved;
    callSummary = {
      unresolved: Number(report.summary.unresolved || 0),
      meaningful: Number(report.summary.meaningful || 0),
      issues: Number(report.summary.issues || 0),
      busy: Number(report.summary.busy || 0),
    };
  } catch (error) {
    console.error("Deli board 3CX load failed", error);
    callError = "3CX call feed unavailable";
  }

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
    calls,
    callSummary,
    callError,
  };
}

export async function GET() {
  try {
    const actor = await boardActor();
    if (!actor) return unauthorized();
    return Response.json({ ...(await loadBoard()), boardAccess: actor.access });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const actor = await boardActor();
    if (!actor) return unauthorized();
    await ensureBoardSchema();

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

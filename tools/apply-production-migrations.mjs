import { neon } from "@neondatabase/serverless";

const force = process.argv.includes("--force");
const productionBuild = process.env.VERCEL_ENV === "production";
const databaseUrl = process.env.DATABASE_URL?.trim();

if (!databaseUrl) {
  if (force) throw new Error("DATABASE_URL is required to apply database migrations.");
  console.log("Database migration skipped: DATABASE_URL is not configured in this build environment.");
  process.exit(0);
}

if (!productionBuild && !force) {
  console.log("Database migration skipped outside a production Vercel build. Run npm run db:migrate for a local database.");
  process.exit(0);
}

const sql = neon(databaseUrl);

async function step(label, query) {
  process.stdout.write(`Migration: ${label}... `);
  await query();
  console.log("done");
}

console.log("Applying Corner Ops database migrations...");

// These steps are intentionally sequential and idempotent. Neon's HTTP batch
// transaction can parse later statements before an earlier DDL statement has
// created the referenced column/table. Sequential execution also lets a failed
// deployment resume safely on the next build.
await step("add conversation key", () => sql`
  ALTER TABLE public.employee_messages
    ADD COLUMN IF NOT EXISTS conversation_key text
`);

await step("backfill conversation keys", () => sql`
  UPDATE public.employee_messages
  SET conversation_key = CASE
    WHEN message_type IN ('Team', 'Announcement') THEN 'team'
    WHEN sender_employee_id IS NULL AND recipient_employee_id IS NOT NULL
      THEN 'owner:' || recipient_employee_id::text
    WHEN sender_employee_id IS NOT NULL AND recipient_employee_id IS NOT NULL
      THEN 'direct:' || LEAST(sender_employee_id::text, recipient_employee_id::text)
        || ':' || GREATEST(sender_employee_id::text, recipient_employee_id::text)
    WHEN sender_employee_id IS NOT NULL
      THEN 'owner:' || sender_employee_id::text
    ELSE 'legacy:' || id::text
  END
  WHERE conversation_key IS NULL OR conversation_key = ''
`);

await step("require conversation keys", () => sql`
  ALTER TABLE public.employee_messages
    ALTER COLUMN conversation_key SET NOT NULL
`);

await step("create recipient snapshots", () => sql`
  CREATE TABLE IF NOT EXISTS public.employee_message_recipients (
    message_id uuid NOT NULL,
    employee_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
  )
`);

await step("create recipient primary key", () => sql`
  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'employee_message_recipients_pkey'
        AND conrelid = 'public.employee_message_recipients'::regclass
    ) THEN
      ALTER TABLE ONLY public.employee_message_recipients
        ADD CONSTRAINT employee_message_recipients_pkey PRIMARY KEY (message_id, employee_id);
    END IF;
  END $$
`);

await step("create message recipient relationship", () => sql`
  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'employee_message_recipients_message_fkey'
        AND conrelid = 'public.employee_message_recipients'::regclass
    ) THEN
      ALTER TABLE ONLY public.employee_message_recipients
        ADD CONSTRAINT employee_message_recipients_message_fkey
        FOREIGN KEY (message_id) REFERENCES public.employee_messages(id) ON DELETE CASCADE;
    END IF;
  END $$
`);

await step("create employee recipient relationship", () => sql`
  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'employee_message_recipients_employee_fkey'
        AND conrelid = 'public.employee_message_recipients'::regclass
    ) THEN
      ALTER TABLE ONLY public.employee_message_recipients
        ADD CONSTRAINT employee_message_recipients_employee_fkey
        FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;
    END IF;
  END $$
`);

await step("snapshot historic team recipients", () => sql`
  INSERT INTO public.employee_message_recipients (message_id, employee_id)
  SELECT m.id, e.id
  FROM public.employee_messages m
  JOIN public.employees e
    ON e.business = m.business
   AND e.created_at <= m.created_at
  WHERE m.conversation_key = 'team'
  ON CONFLICT (message_id, employee_id) DO NOTHING
`);

await step("snapshot historic direct recipients", () => sql`
  INSERT INTO public.employee_message_recipients (message_id, employee_id)
  SELECT m.id, participant.employee_id
  FROM public.employee_messages m
  CROSS JOIN LATERAL (
    VALUES (m.sender_employee_id), (m.recipient_employee_id)
  ) AS participant(employee_id)
  WHERE participant.employee_id IS NOT NULL
    AND m.conversation_key <> 'team'
  ON CONFLICT (message_id, employee_id) DO NOTHING
`);

await step("allow conversation message type", () => sql`
  ALTER TABLE ONLY public.employee_messages
    DROP CONSTRAINT IF EXISTS employee_messages_message_type_check,
    ADD CONSTRAINT employee_messages_message_type_check
    CHECK (message_type = ANY (ARRAY[
      'Team'::text,
      'Direct'::text,
      'Announcement'::text,
      'Conversation'::text
    ]))
`);

await step("retire dynamic team visibility", () => sql`
  UPDATE public.employee_messages
  SET message_type = 'Conversation'
  WHERE message_type IN ('Team', 'Announcement')
`);

await step("index conversations", () => sql`
  CREATE INDEX IF NOT EXISTS employee_messages_conversation_idx
    ON public.employee_messages (business, conversation_key, created_at, id)
    WHERE deleted_at IS NULL
`);

await step("index recipient inboxes", () => sql`
  CREATE INDEX IF NOT EXISTS employee_message_recipients_employee_idx
    ON public.employee_message_recipients (employee_id, message_id)
`);

const [result] = await sql`
  SELECT
    COUNT(*)::int AS messages,
    (SELECT COUNT(*)::int FROM public.employee_message_recipients) AS recipient_snapshots
  FROM public.employee_messages
  WHERE conversation_key IS NOT NULL
`;

console.log(`Database migrations complete: ${result?.messages || 0} messages and ${result?.recipient_snapshots || 0} recipient snapshots ready.`);

-- Idempotent compatibility bridge from the former build-time migration runner.
-- The migration ledger applies this once; later builds never repeat data backfills.

-- add conversation key
ALTER TABLE public.employee_messages
    ADD COLUMN IF NOT EXISTS conversation_key text;

-- backfill conversation keys
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
  WHERE conversation_key IS NULL OR conversation_key = '';

-- require conversation keys
ALTER TABLE public.employee_messages
    ALTER COLUMN conversation_key SET NOT NULL;

-- create recipient snapshots
CREATE TABLE IF NOT EXISTS public.employee_message_recipients (
    message_id uuid NOT NULL,
    employee_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
  );

-- create recipient primary key
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
  END $$;

-- create message recipient relationship
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
  END $$;

-- create employee recipient relationship
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
  END $$;

-- snapshot historic team recipients
INSERT INTO public.employee_message_recipients (message_id, employee_id)
  SELECT m.id, e.id
  FROM public.employee_messages m
  JOIN public.employees e
    ON e.business = m.business
   AND e.created_at <= m.created_at
  WHERE m.conversation_key = 'team'
  ON CONFLICT (message_id, employee_id) DO NOTHING;

-- snapshot historic direct recipients
INSERT INTO public.employee_message_recipients (message_id, employee_id)
  SELECT m.id, participant.employee_id
  FROM public.employee_messages m
  CROSS JOIN LATERAL (
    VALUES (m.sender_employee_id), (m.recipient_employee_id)
  ) AS participant(employee_id)
  WHERE participant.employee_id IS NOT NULL
    AND m.conversation_key <> 'team'
  ON CONFLICT (message_id, employee_id) DO NOTHING;

-- allow conversation message type
ALTER TABLE ONLY public.employee_messages
    DROP CONSTRAINT IF EXISTS employee_messages_message_type_check,
    ADD CONSTRAINT employee_messages_message_type_check
    CHECK (message_type = ANY (ARRAY[
      'Team'::text,
      'Direct'::text,
      'Announcement'::text,
      'Conversation'::text
    ]));

-- retire dynamic team visibility
UPDATE public.employee_messages
  SET message_type = 'Conversation'
  WHERE message_type IN ('Team', 'Announcement');

-- index conversations
CREATE INDEX IF NOT EXISTS employee_messages_conversation_idx
    ON public.employee_messages (business, conversation_key, created_at, id)
    WHERE deleted_at IS NULL;

-- index recipient inboxes
CREATE INDEX IF NOT EXISTS employee_message_recipients_employee_idx
    ON public.employee_message_recipients (employee_id, message_id);

-- release future shifts assigned to archived employees
UPDATE public.schedule_shifts s
  SET employee_id = NULL,
    status = 'Draft',
    published_at = NULL,
    notes = CASE
      WHEN COALESCE(s.notes, '') LIKE '%Released after employee was archived.%' THEN s.notes
      WHEN BTRIM(COALESCE(s.notes, '')) = '' THEN 'Released after employee was archived.'
      ELSE BTRIM(s.notes) || E'\nReleased after employee was archived.'
    END,
    updated_at = NOW()
  FROM public.employees e
  WHERE s.employee_id = e.id
    AND e.active = FALSE
    AND s.status <> 'Cancelled'
    AND s.ends_at >= NOW();

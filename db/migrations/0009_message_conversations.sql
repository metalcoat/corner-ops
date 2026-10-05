-- Stable messaging channels with per-message recipient snapshots.
-- A new employee can participate in future team messages without inheriting messages
-- sent before their employee record existed.

ALTER TABLE public.employee_messages
  ADD COLUMN conversation_key text;

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

ALTER TABLE public.employee_messages
  ALTER COLUMN conversation_key SET NOT NULL;

CREATE TABLE public.employee_message_recipients (
  message_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.employee_message_recipients
  ADD CONSTRAINT employee_message_recipients_pkey PRIMARY KEY (message_id, employee_id);

ALTER TABLE ONLY public.employee_message_recipients
  ADD CONSTRAINT employee_message_recipients_message_fkey
  FOREIGN KEY (message_id) REFERENCES public.employee_messages(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.employee_message_recipients
  ADD CONSTRAINT employee_message_recipients_employee_fkey
  FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;

-- Team-message history is snapshotted to employees who already existed when the
-- message was sent. This intentionally excludes employees added afterward.
INSERT INTO public.employee_message_recipients (message_id, employee_id)
SELECT m.id, e.id
FROM public.employee_messages m
JOIN public.employees e
  ON e.business = m.business
 AND e.created_at <= m.created_at
WHERE m.message_type IN ('Team', 'Announcement')
ON CONFLICT (message_id, employee_id) DO NOTHING;

-- Direct history belongs only to the original sender and recipient.
INSERT INTO public.employee_message_recipients (message_id, employee_id)
SELECT m.id, participant.employee_id
FROM public.employee_messages m
CROSS JOIN LATERAL (
  VALUES (m.sender_employee_id), (m.recipient_employee_id)
) AS participant(employee_id)
WHERE participant.employee_id IS NOT NULL
  AND m.message_type NOT IN ('Team', 'Announcement')
ON CONFLICT (message_id, employee_id) DO NOTHING;

ALTER TABLE ONLY public.employee_messages
  DROP CONSTRAINT IF EXISTS employee_messages_message_type_check,
  ADD CONSTRAINT employee_messages_message_type_check
  CHECK (message_type = ANY (ARRAY[
    'Team'::text,
    'Direct'::text,
    'Announcement'::text,
    'Conversation'::text
  ]));

-- Conversation visibility is now governed by the immutable recipient snapshot,
-- not by a live "all active employees" predicate in older clients.
UPDATE public.employee_messages
SET message_type = 'Conversation'
WHERE message_type IN ('Team', 'Announcement');

CREATE INDEX employee_messages_conversation_idx
  ON public.employee_messages (business, conversation_key, created_at, id)
  WHERE deleted_at IS NULL;

CREATE INDEX employee_message_recipients_employee_idx
  ON public.employee_message_recipients (employee_id, message_id);

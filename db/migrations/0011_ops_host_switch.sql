-- One-time, short-lived login handoffs between the two operations domains.
CREATE TABLE IF NOT EXISTS public.ops_host_switches (
  code_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE,
  session_version integer NOT NULL,
  target_host text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ops_host_switches_expires_at_idx
  ON public.ops_host_switches (expires_at);

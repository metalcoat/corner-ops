-- Store rules for the AI phone line (Chris, 2026-11-07: change how the AI orders without a deploy). Managers
-- edit them in POS Settings; the active ones are added to the AI's instructions at the start of each call and
-- shown to the Claude order checker. Prices, menu checks, the card line and hand-offs stay in code.
CREATE TABLE IF NOT EXISTS ordering_ai_phone_rules (
  id uuid PRIMARY KEY,
  business text NOT NULL,
  position integer NOT NULL DEFAULT 0,
  title text NOT NULL DEFAULT '',
  rule text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_by text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ordering_ai_phone_rules_business_idx ON ordering_ai_phone_rules (business, position, created_at);

-- Every change keeps the text before and after, so an edit that made calls worse can be put back.
CREATE TABLE IF NOT EXISTS ordering_ai_phone_rule_history (
  id bigserial PRIMARY KEY,
  rule_id uuid NOT NULL,
  business text NOT NULL,
  action text NOT NULL CHECK (action IN ('create', 'update', 'delete')),
  before jsonb,
  after jsonb,
  actor_id text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ordering_ai_phone_rule_history_rule_idx ON ordering_ai_phone_rule_history (business, created_at DESC);

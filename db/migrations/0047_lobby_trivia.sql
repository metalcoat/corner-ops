-- Lobby trivia: customers scan the greeter TV's rotating QR, pick a nickname and answer up to 15
-- questions a store day (questions live in src/lib/trivia-questions.ts, stored here by id).
-- Every answer is checked on the server; boards count correct answers.
CREATE TABLE IF NOT EXISTS trivia_settings (
  business text PRIMARY KEY,
  enabled boolean NOT NULL,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS trivia_players (
  id bigserial PRIMARY KEY,
  business text NOT NULL,
  nickname text NOT NULL,
  -- Set from a customer's verified SMS/email sign-in on the ordering site, so scores follow them across phones.
  customer_id uuid REFERENCES ordering_customers(id) ON DELETE SET NULL,
  -- Hidden from every board (POS Settings); the player can still play.
  hidden boolean NOT NULL DEFAULT false,
  hidden_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS trivia_players_customer_idx ON trivia_players (business, customer_id) WHERE customer_id IS NOT NULL;

-- One row per question shown to a player; answered_at stays empty until they answer.
CREATE TABLE IF NOT EXISTS trivia_answers (
  id bigserial PRIMARY KEY,
  player_id bigint NOT NULL REFERENCES trivia_players(id) ON DELETE CASCADE,
  business_date date NOT NULL,
  question_id text NOT NULL,
  asked_at timestamptz NOT NULL DEFAULT now(),
  choice text,
  correct boolean,
  answered_at timestamptz,
  UNIQUE (player_id, business_date, question_id)
);
CREATE INDEX IF NOT EXISTS trivia_answers_board_idx ON trivia_answers (business_date, player_id) WHERE correct;
CREATE INDEX IF NOT EXISTS trivia_answers_recent_idx ON trivia_answers (answered_at DESC) WHERE answered_at IS NOT NULL;

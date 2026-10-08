CREATE TABLE IF NOT EXISTS arcade_leaderboards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id VARCHAR(50) NOT NULL,
  player_name VARCHAR(30) NOT NULL,
  score INTEGER NOT NULL,
  metadata JSONB DEFAULT '{}'::jsonb,
  customer_id UUID REFERENCES ordering_customers(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_arcade_game_scores 
ON arcade_leaderboards(game_id, score DESC, created_at ASC);

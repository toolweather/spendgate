CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  label TEXT,
  tier TEXT NOT NULL DEFAULT 'free',
  daily_limit INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  owner_hint TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_api_keys_owner_created
  ON api_keys (owner_hint, created_at);

CREATE TABLE IF NOT EXISTS usage_daily (
  subject TEXT NOT NULL,
  day TEXT NOT NULL,
  score_count INTEGER NOT NULL DEFAULT 0,
  paid_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (subject, day)
);

CREATE TABLE IF NOT EXISTS payments (
  nonce TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  payer TEXT,
  tx_hash TEXT,
  amount TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

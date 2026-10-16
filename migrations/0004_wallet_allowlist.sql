-- One row per API key. set_wallet_allowlist replaces it in a single write.
-- Addresses only. The key secret and the spend body are not stored here.
CREATE TABLE IF NOT EXISTS wallet_allowlist (
  key_id TEXT PRIMARY KEY,
  wallets_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

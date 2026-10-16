-- Truncated caller hashes only. No raw IPs or API keys.
-- Counting starts when this migration is applied. There is no backfill.
CREATE TABLE IF NOT EXISTS source_callers (
  day TEXT NOT NULL,
  src TEXT NOT NULL,
  caller_hash TEXT NOT NULL,
  outcome TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, src, caller_hash, outcome)
);

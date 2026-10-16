-- SpendGate Pro demand-test waitlist.
-- email is the unique key, so a repeat signup inserts nothing.
-- ip_hash is a UTC-day hash of the client address, not the raw IP.
CREATE TABLE IF NOT EXISTS waitlist (
  email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  source TEXT,
  ip_hash TEXT NOT NULL,
  PRIMARY KEY (email)
);

CREATE INDEX IF NOT EXISTS idx_waitlist_ip_hash
  ON waitlist (ip_hash);

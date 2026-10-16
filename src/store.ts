export interface UsageSnapshot {
  scoreCount: number;
  paidCount: number;
}

export interface StoredKey {
  id: string;
  keyHash: string;
  keyPrefix: string;
  label: string | null;
  tier: "free";
  dailyLimit: number;
  createdAt: string;
  ownerHint: string;
}

export interface StoredPayment {
  nonce: string;
  subject: string;
  payer: string | null;
  txHash: string | null;
  amount: string;
  responseJson: string;
  createdAt: string;
}

export interface WaitlistSignup {
  email: string;
  createdAt: string;
  source: string | null;
  /** UTC-day hash of the client address. Not the raw IP. */
  ipHash: string;
  ipDailyCap: number;
}

export type WaitlistJoinResult = "created" | "duplicate" | "rate_limited";

export interface UsageStore {
  getKeyByHash(hash: string): Promise<StoredKey | null>;
  insertKey(row: StoredKey): Promise<void>;
  countKeysSince(ownerHint: string, sinceIso: string): Promise<number>;
  getUsage(subject: string, day: string): Promise<UsageSnapshot>;
  tryConsumeFree(subject: string, day: string, limit: number): Promise<boolean>;
  addPaid(subject: string, day: string): Promise<void>;
  getPayment(nonce: string): Promise<StoredPayment | null>;
  recordPayment(row: StoredPayment): Promise<void>;
  /**
   * Insert one waitlist row, or insert nothing when the email exists or the
   * daily IP cap is already full. A created signup is a single write.
   */
  joinWaitlist(row: WaitlistSignup): Promise<WaitlistJoinResult>;
  /** Number of stored addresses. Never returns the addresses. */
  countWaitlist(): Promise<number>;
  /** Null when this key has never stored a list. An empty array is a stored list that authorizes nothing. */
  getWalletAllowlist(keyId: string): Promise<string[] | null>;
  /** Replace the key's allowlist in one write. */
  setWalletAllowlist(keyId: string, wallets: string[], updatedAt: string): Promise<void>;
}

function emptyUsage(): UsageSnapshot {
  return { scoreCount: 0, paidCount: 0 };
}

interface MemoryWaitlistRow {
  email: string;
  createdAt: string;
  source: string | null;
  ipHash: string;
}

interface MemoryAllowlist {
  wallets: string[];
  updatedAt: string;
}

export class MemoryUsageStore implements UsageStore {
  private keys = new Map<string, StoredKey>();
  private usage = new Map<string, UsageSnapshot>();
  private payments = new Map<string, StoredPayment>();
  private waitlist = new Map<string, MemoryWaitlistRow>();
  private allowlists = new Map<string, MemoryAllowlist>();

  async getKeyByHash(hash: string): Promise<StoredKey | null> {
    return this.keys.get(hash) ?? null;
  }

  async insertKey(row: StoredKey): Promise<void> {
    this.keys.set(row.keyHash, row);
  }

  async countKeysSince(ownerHint: string, sinceIso: string): Promise<number> {
    let n = 0;
    for (const row of this.keys.values()) {
      if (row.ownerHint === ownerHint && row.createdAt >= sinceIso) n += 1;
    }
    return n;
  }

  async getUsage(subject: string, day: string): Promise<UsageSnapshot> {
    return this.usage.get(`${subject}|${day}`) ?? emptyUsage();
  }

  async tryConsumeFree(subject: string, day: string, limit: number): Promise<boolean> {
    if (limit <= 0) return false;
    const key = `${subject}|${day}`;
    const row = this.usage.get(key) ?? emptyUsage();
    if (row.scoreCount >= limit) return false;
    this.usage.set(key, { scoreCount: row.scoreCount + 1, paidCount: row.paidCount });
    return true;
  }

  async addPaid(subject: string, day: string): Promise<void> {
    const key = `${subject}|${day}`;
    const row = this.usage.get(key) ?? emptyUsage();
    this.usage.set(key, { scoreCount: row.scoreCount, paidCount: row.paidCount + 1 });
  }

  async getPayment(nonce: string): Promise<StoredPayment | null> {
    return this.payments.get(nonce) ?? null;
  }

  async recordPayment(row: StoredPayment): Promise<void> {
    this.payments.set(row.nonce, row);
  }

  async joinWaitlist(row: WaitlistSignup): Promise<WaitlistJoinResult> {
    if (this.waitlist.has(row.email)) return "duplicate";
    let fromIp = 0;
    for (const existing of this.waitlist.values()) {
      if (existing.ipHash === row.ipHash) fromIp += 1;
    }
    if (fromIp >= row.ipDailyCap) return "rate_limited";
    this.waitlist.set(row.email, {
      email: row.email,
      createdAt: row.createdAt,
      source: row.source,
      ipHash: row.ipHash,
    });
    return "created";
  }

  async countWaitlist(): Promise<number> {
    return this.waitlist.size;
  }

  async getWalletAllowlist(keyId: string): Promise<string[] | null> {
    const row = this.allowlists.get(keyId);
    return row ? [...row.wallets] : null;
  }

  async setWalletAllowlist(keyId: string, wallets: string[], updatedAt: string): Promise<void> {
    this.allowlists.set(keyId, { wallets: [...wallets], updatedAt });
  }
}

interface KeyRow {
  id: string;
  key_hash: string;
  key_prefix: string;
  label: string | null;
  tier: string;
  daily_limit: number;
  created_at: string;
  owner_hint: string;
}

function mapKey(row: KeyRow): StoredKey {
  return {
    id: row.id,
    keyHash: row.key_hash,
    keyPrefix: row.key_prefix,
    label: row.label,
    tier: "free",
    dailyLimit: row.daily_limit,
    createdAt: row.created_at,
    ownerHint: row.owner_hint,
  };
}

export class D1UsageStore implements UsageStore {
  constructor(private readonly db: D1Database) {}

  async getKeyByHash(hash: string): Promise<StoredKey | null> {
    const row = await this.db
      .prepare(
        `SELECT id, key_hash, key_prefix, label, tier, daily_limit, created_at, owner_hint
         FROM api_keys WHERE key_hash = ?`,
      )
      .bind(hash)
      .first<KeyRow>();
    return row ? mapKey(row) : null;
  }

  async insertKey(row: StoredKey): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO api_keys (id, key_hash, key_prefix, label, tier, daily_limit, created_at, owner_hint)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(row.id, row.keyHash, row.keyPrefix, row.label, row.tier, row.dailyLimit, row.createdAt, row.ownerHint)
      .run();
  }

  async countKeysSince(ownerHint: string, sinceIso: string): Promise<number> {
    const row = await this.db
      .prepare(`SELECT COUNT(*) AS n FROM api_keys WHERE owner_hint = ? AND created_at >= ?`)
      .bind(ownerHint, sinceIso)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  async getUsage(subject: string, day: string): Promise<UsageSnapshot> {
    const row = await this.db
      .prepare(`SELECT score_count, paid_count FROM usage_daily WHERE subject = ? AND day = ?`)
      .bind(subject, day)
      .first<{ score_count: number; paid_count: number }>();
    if (!row) return emptyUsage();
    return { scoreCount: row.score_count, paidCount: row.paid_count };
  }

  async tryConsumeFree(subject: string, day: string, limit: number): Promise<boolean> {
    if (limit <= 0) return false;
    const result = await this.db
      .prepare(
        `INSERT INTO usage_daily (subject, day, score_count, paid_count)
         VALUES (?, ?, 1, 0)
         ON CONFLICT (subject, day) DO UPDATE SET
           score_count = score_count + 1
         WHERE usage_daily.score_count < ?`,
      )
      .bind(subject, day, limit)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async addPaid(subject: string, day: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO usage_daily (subject, day, score_count, paid_count)
         VALUES (?, ?, 0, 1)
         ON CONFLICT (subject, day) DO UPDATE SET
           paid_count = paid_count + 1`,
      )
      .bind(subject, day)
      .run();
  }

  async getPayment(nonce: string): Promise<StoredPayment | null> {
    const row = await this.db
      .prepare(
        `SELECT nonce, subject, payer, tx_hash, amount, response_json, created_at
         FROM payments WHERE nonce = ?`,
      )
      .bind(nonce)
      .first<{
        nonce: string;
        subject: string;
        payer: string | null;
        tx_hash: string | null;
        amount: string;
        response_json: string;
        created_at: string;
      }>();
    if (!row) return null;
    return {
      nonce: row.nonce,
      subject: row.subject,
      payer: row.payer,
      txHash: row.tx_hash,
      amount: row.amount,
      responseJson: row.response_json,
      createdAt: row.created_at,
    };
  }

  async recordPayment(row: StoredPayment): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO payments (nonce, subject, payer, tx_hash, amount, response_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(row.nonce, row.subject, row.payer, row.txHash, row.amount, row.responseJson, row.createdAt)
      .run();
  }

  async joinWaitlist(row: WaitlistSignup): Promise<WaitlistJoinResult> {
    // One statement: the IP cap is a read inside the insert, and the email
    // primary key drops a duplicate without a second write.
    const inserted = await this.db
      .prepare(
        `INSERT INTO waitlist (email, created_at, source, ip_hash)
         SELECT ?, ?, ?, ?
         WHERE (SELECT COUNT(*) FROM waitlist WHERE ip_hash = ?) < ?
         ON CONFLICT(email) DO NOTHING`,
      )
      .bind(row.email, row.createdAt, row.source, row.ipHash, row.ipHash, row.ipDailyCap)
      .run();
    if ((inserted.meta.changes ?? 0) > 0) return "created";
    const existing = await this.db
      .prepare(`SELECT 1 AS ok FROM waitlist WHERE email = ?`)
      .bind(row.email)
      .first<{ ok: number }>();
    return existing ? "duplicate" : "rate_limited";
  }

  async countWaitlist(): Promise<number> {
    const row = await this.db.prepare(`SELECT COUNT(*) AS n FROM waitlist`).first<{ n: number }>();
    return row?.n ?? 0;
  }

  async getWalletAllowlist(keyId: string): Promise<string[] | null> {
    const row = await this.db
      .prepare(`SELECT wallets_json FROM wallet_allowlist WHERE key_id = ?`)
      .bind(keyId)
      .first<{ wallets_json: string }>();
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.wallets_json) as unknown;
      if (!Array.isArray(parsed)) return null;
      return parsed.filter((item): item is string => typeof item === "string");
    } catch {
      return null;
    }
  }

  async setWalletAllowlist(keyId: string, wallets: string[], updatedAt: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO wallet_allowlist (key_id, wallets_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key_id) DO UPDATE SET
           wallets_json = excluded.wallets_json,
           updated_at = excluded.updated_at`,
      )
      .bind(keyId, JSON.stringify(wallets), updatedAt)
      .run();
  }
}

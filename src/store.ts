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

export interface UsageStore {
  getKeyByHash(hash: string): Promise<StoredKey | null>;
  insertKey(row: StoredKey): Promise<void>;
  countKeysSince(ownerHint: string, sinceIso: string): Promise<number>;
  getUsage(subject: string, day: string): Promise<UsageSnapshot>;
  tryConsumeFree(subject: string, day: string, limit: number): Promise<boolean>;
  addPaid(subject: string, day: string): Promise<void>;
  getPayment(nonce: string): Promise<StoredPayment | null>;
  recordPayment(row: StoredPayment): Promise<void>;
}

function emptyUsage(): UsageSnapshot {
  return { scoreCount: 0, paidCount: 0 };
}

export class MemoryUsageStore implements UsageStore {
  private keys = new Map<string, StoredKey>();
  private usage = new Map<string, UsageSnapshot>();
  private payments = new Map<string, StoredPayment>();

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
}

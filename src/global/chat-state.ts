import type { Lock, QueueEntry, StateAdapter } from "chat";

const LOCK_PREFIX = "lock:";
const SUB_PREFIX = "sub:";
const LIST_PREFIX = "list:";
const QUEUE_PREFIX = "queue:";

interface StateRow {
  key: string;
  value: string;
  expires_at: number | null;
}

function parseValue<T>(row: StateRow | undefined | null): T | null {
  if (!row) return null;
  if (row.expires_at !== null && row.expires_at <= Date.now()) {
    return null;
  }
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

/**
 * D1-backed StateAdapter for chat SDK bots.
 *
 * One KV table (`chat_state`) covers cached values, thread locks, thread
 * subscriptions, append-only lists, and per-thread queues. Expired rows are
 * treated as absent and reaped lazily on access.
 */
export class D1StateAdapter implements StateAdapter {
  constructor(private readonly db: D1Database) {}

  connect(): Promise<void> {
    return Promise.resolve();
  }

  disconnect(): Promise<void> {
    return Promise.resolve();
  }

  private async row(key: string): Promise<StateRow | null> {
    return await this.db
      .prepare(
        "SELECT key, value, expires_at FROM chat_state WHERE key = ? LIMIT 1"
      )
      .bind(key)
      .first<StateRow>();
  }

  private async reapIfExpired(key: string): Promise<void> {
    await this.db
      .prepare(
        "DELETE FROM chat_state WHERE key = ? AND expires_at IS NOT NULL AND expires_at <= ?"
      )
      .bind(key, Date.now())
      .run();
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    await this.reapIfExpired(key);
    return parseValue<T>(await this.row(key));
  }

  async set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void> {
    const expiresAt = ttlMs === undefined ? null : Date.now() + ttlMs;
    await this.db
      .prepare(
        "INSERT OR REPLACE INTO chat_state (key, value, expires_at) VALUES (?, ?, ?)"
      )
      .bind(key, JSON.stringify(value), expiresAt)
      .run();
  }

  async delete(key: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM chat_state WHERE key = ?")
      .bind(key)
      .run();
  }

  async setIfNotExists(
    key: string,
    value: unknown,
    ttlMs?: number
  ): Promise<boolean> {
    await this.reapIfExpired(key);
    const expiresAt = ttlMs === undefined ? null : Date.now() + ttlMs;
    const result = await this.db
      .prepare(
        "INSERT OR IGNORE INTO chat_state (key, value, expires_at) VALUES (?, ?, ?)"
      )
      .bind(key, JSON.stringify(value), expiresAt)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async acquireLock(threadId: string, ttlMs: number): Promise<Lock | null> {
    const key = `${LOCK_PREFIX}${threadId}`;
    const lock: Lock = {
      threadId,
      token: crypto.randomUUID(),
      expiresAt: Date.now() + ttlMs,
    };
    const acquired = await this.setIfNotExists(key, lock, ttlMs + 60_000);
    return acquired ? lock : null;
  }

  async extendLock(lock: Lock, ttlMs: number): Promise<boolean> {
    const key = `${LOCK_PREFIX}${lock.threadId}`;
    const next: Lock = { ...lock, expiresAt: Date.now() + ttlMs };
    const result = await this.db
      .prepare(
        `UPDATE chat_state
         SET value = ?, expires_at = ?
         WHERE key = ?
           AND expires_at > ?
           AND json_extract(value, '$.token') = ?`
      )
      .bind(
        JSON.stringify(next),
        next.expiresAt + 60_000,
        key,
        Date.now(),
        lock.token
      )
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async releaseLock(lock: Lock): Promise<void> {
    await this.db
      .prepare(
        "DELETE FROM chat_state WHERE key = ? AND json_extract(value, '$.token') = ?"
      )
      .bind(`${LOCK_PREFIX}${lock.threadId}`, lock.token)
      .run();
  }

  async forceReleaseLock(threadId: string): Promise<void> {
    await this.delete(`${LOCK_PREFIX}${threadId}`);
  }

  async subscribe(threadId: string): Promise<void> {
    await this.set(`${SUB_PREFIX}${threadId}`, true);
  }

  async unsubscribe(threadId: string): Promise<void> {
    await this.delete(`${SUB_PREFIX}${threadId}`);
  }

  async isSubscribed(threadId: string): Promise<boolean> {
    return (await this.get<boolean>(`${SUB_PREFIX}${threadId}`)) === true;
  }

  async appendToList(
    key: string,
    value: unknown,
    options?: { maxLength?: number; ttlMs?: number }
  ): Promise<void> {
    const listKey = `${LIST_PREFIX}${key}`;
    const list = (await this.get<unknown[]>(listKey)) ?? [];
    list.push(value);
    const maxLength = options?.maxLength;
    const trimmed =
      maxLength !== undefined && list.length > maxLength
        ? list.slice(list.length - maxLength)
        : list;
    await this.set(listKey, trimmed, options?.ttlMs);
  }

  async getList<T = unknown>(key: string): Promise<T[]> {
    return (await this.get<T[]>(`${LIST_PREFIX}${key}`)) ?? [];
  }

  async enqueue(
    threadId: string,
    entry: QueueEntry,
    maxSize: number
  ): Promise<number> {
    const key = `${QUEUE_PREFIX}${threadId}`;
    const queue = (await this.get<QueueEntry[]>(key)) ?? [];
    queue.push(entry);
    const trimmed =
      queue.length > maxSize ? queue.slice(queue.length - maxSize) : queue;
    await this.set(key, trimmed);
    return trimmed.length;
  }

  async dequeue(threadId: string): Promise<QueueEntry | null> {
    const key = `${QUEUE_PREFIX}${threadId}`;
    const now = Date.now();
    const queue = (await this.get<QueueEntry[]>(key)) ?? [];
    const index = queue.findIndex((entry) => entry.expiresAt > now);
    if (index === -1) {
      await this.delete(key);
      return null;
    }
    const [entry] = queue.splice(index, 1);
    if (queue.length === 0) {
      await this.delete(key);
    } else {
      await this.set(key, queue);
    }
    return entry ?? null;
  }

  async queueDepth(threadId: string): Promise<number> {
    const queue =
      (await this.get<QueueEntry[]>(`${QUEUE_PREFIX}${threadId}`)) ?? [];
    return queue.length;
  }
}

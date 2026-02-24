import { v4 as uuidv4 } from "uuid";

export type MemoryTier = "short" | "long";

export type MemoryRecord = {
  id: string;
  userId: string;
  tier: MemoryTier;
  content: string;
  importance: number;
  source: string | null;
  created_at: number;
  updated_at: number | null;
};

export type CreateMemoryInput = {
  id?: string;
  userId: string;
  tier: MemoryTier;
  content: string;
  importance?: number;
  source?: string;
};

export class DB {
  private static instance: Promise<DB> | null = null;
  private env!: Env;

  private constructor() { }

  static getInstance(env: Env): Promise<DB> {
    if (!this.instance) {
      this.instance = (async () => {
        const db = new DB();
        try {
          await db.init(env);
          return db;
        } catch (error) {
          this.instance = null;
          throw error;
        }
      })();
    }
    return this.instance;
  }

  private async init(env: Env) {
    this.env = env;

    await this.env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS memories (
         id TEXT PRIMARY KEY,
         userId TEXT NOT NULL,
         tier TEXT NOT NULL,
         content TEXT NOT NULL,
         importance REAL DEFAULT 0,
         source TEXT,
         created_at INTEGER NOT NULL,
         updated_at INTEGER
       )`
    ).run();

    await this.env.DB.prepare(
      `CREATE INDEX IF NOT EXISTS idx_memories_user_tier
       ON memories (userId, tier)`
    ).run();
  }

  async createMemory(params: CreateMemoryInput) {
    const id = params.id ?? `${params.userId}:${params.tier}:${uuidv4()}`;
    const now = Date.now();

    await this.env.DB.prepare(
      `INSERT INTO memories
       (id, userId, tier, content, importance, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id,
        params.userId,
        params.tier,
        params.content,
        params.importance ?? 0,
        params.source ?? null,
        now
      )
      .run();

    return id;
  }

  async batchCreateMemories(memories: CreateMemoryInput[]): Promise<string[]> {
    const ids: string[] = [];

    for (const memory of memories) {
      const id = await this.createMemory(memory);
      ids.push(id);
    }

    return ids;
  }

  async getMemories(
    userId: string,
    tier: MemoryTier,
    limit: number = 50
  ): Promise<MemoryRecord[]> {
    const result = await this.env.DB.prepare(
      `SELECT id, userId, tier, content, importance, source, created_at, updated_at
       FROM memories
       WHERE userId = ? AND tier = ?
       ORDER BY created_at DESC
       LIMIT ?`
    )
      .bind(userId, tier, limit)
      .all<MemoryRecord>();

    return result.results ?? [];
  }

  async getAllMemories(
    userId: string,
    tier?: MemoryTier
  ): Promise<MemoryRecord[]> {
    let result;

    if (tier) {
      result = await this.env.DB.prepare(
        `SELECT id, userId, tier, content, importance, source, created_at, updated_at
         FROM memories
         WHERE userId = ? AND tier = ?
         ORDER BY created_at DESC`
      )
        .bind(userId, tier)
        .all<MemoryRecord>();
    } else {
      result = await this.env.DB.prepare(
        `SELECT id, userId, tier, content, importance, source, created_at, updated_at
         FROM memories
         WHERE userId = ?
         ORDER BY created_at DESC`
      )
        .bind(userId)
        .all<MemoryRecord>();
    }

    return result.results ?? [];
  }

  async getMemoryById(
    memoryId: string,
    userId: string
  ): Promise<MemoryRecord | null> {
    const result = await this.env.DB.prepare(
      `SELECT id, userId, tier, content, importance, source, created_at, updated_at
       FROM memories
       WHERE id = ? AND userId = ?
       LIMIT 1`
    )
      .bind(memoryId, userId)
      .all<MemoryRecord>();

    return result.results?.[0] ?? null;
  }

  async getMemoryStats(userId: string): Promise<{
    short: number;
    long: number;
    total: number;
  }> {
    const result = await this.env.DB.prepare(
      `SELECT tier, COUNT(*) as count
       FROM memories
       WHERE userId = ?
       GROUP BY tier`
    )
      .bind(userId)
      .all<{ tier: string; count: number }>();

    let short = 0;
    let long = 0;

    for (const row of result.results ?? []) {
      const count = Number(row.count) || 0;
      if (row.tier === "short") short = count;
      if (row.tier === "long") long = count;
    }

    return {
      short,
      long,
      total: short + long,
    };
  }

  async getMemoryCount(userId: string, tier?: MemoryTier): Promise<number> {
    const result = tier
      ? await this.env.DB.prepare(
        `SELECT COUNT(*) as count
         FROM memories
         WHERE userId = ? AND tier = ?`
      )
        .bind(userId, tier)
        .all<{ count: number }>()
      : await this.env.DB.prepare(
        `SELECT COUNT(*) as count
         FROM memories
         WHERE userId = ?`
      )
        .bind(userId)
        .all<{ count: number }>();

    const value = result.results?.[0]?.count ?? 0;
    return Number(value) || 0;
  }

  async deleteMemory(memoryId: string, userId: string) {
    const result = await this.env.DB.prepare(
      "DELETE FROM memories WHERE id = ? AND userId = ?"
    )
      .bind(memoryId, userId)
      .run();

    return (result.meta?.changes ?? 0) > 0;
  }

  async clearAllMemories(userId: string, tier?: MemoryTier): Promise<number> {
    const result = tier
      ? await this.env.DB.prepare(
        `DELETE FROM memories
         WHERE userId = ? AND tier = ?`
      )
        .bind(userId, tier)
        .run()
      : await this.env.DB.prepare(
        `DELETE FROM memories
         WHERE userId = ?`
      )
        .bind(userId)
        .run();

    return result.meta?.changes ?? 0;
  }

  async updateMemory(
    memoryId: string,
    userId: string,
    newContent: string
  ) {
    const now = Date.now();

    const result = await this.env.DB.prepare(
      `UPDATE memories
       SET content = ?, updated_at = ?
       WHERE id = ? AND userId = ?`
    )
      .bind(newContent, now, memoryId, userId)
      .run();

    if (!result.meta || result.meta.changes === 0) {
      throw new Error("Memory not found");
    }
  }
}

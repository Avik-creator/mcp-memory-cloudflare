import { v4 as uuidv4 } from "uuid";

export class DB {
  private static instance: Promise<DB> | null = null;
  private env!: Env;

  private constructor() { }

  static getInstance(env: Env): Promise<DB> {
    if (!this.instance) {
      this.instance = (async () => {
        const db = new DB();
        await db.init(env);
        return db;
      })();
    }
    return this.instance;
  }

  private async init(env: Env) {
    this.env = env;

    await this.env.DB.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        tier TEXT NOT NULL,
        content TEXT NOT NULL,
        importance REAL DEFAULT 0,
        source TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_memories_user_tier
      ON memories (userId, tier);
    `);
  }

  async createMemory(params: {
    id?: string;
    userId: string;
    tier: "short" | "long";
    content: string;
    importance?: number;
    source?: string;
  }) {
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

  async getMemories(userId: string, tier: "short" | "long") {
    const result = await this.env.DB.prepare(
      `SELECT id, content, created_at, updated_at, importance
       FROM memories
       WHERE userId = ? AND tier = ?
       ORDER BY created_at DESC`
    )
      .bind(userId, tier)
      .all();

    return result.results;
  }

  async deleteMemory(memoryId: string, userId: string) {
    await this.env.DB.prepare(
      "DELETE FROM memories WHERE id = ? AND userId = ?"
    )
      .bind(memoryId, userId)
      .run();
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
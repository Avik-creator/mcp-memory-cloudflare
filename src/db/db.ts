import { v4 as uuidv4 } from "uuid";

export class DB {
  private static instance: Promise<DB> | null = null;
  private env!: Env;

  private constructor() { }

  // ---- singleton entry ----
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

  // ---- init runs once per isolate ----
  private async init(env: Env) {
    this.env = env;

    console.log("Initializing D1 schema…");

    await this.env.DB.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log("D1 ready");
  }

  // -----------------------------
  // methods
  // -----------------------------

  async storeMemory(content: string, userId: string, memoryId: string = uuidv4()) {
    await this.env.DB.prepare(
      "INSERT INTO memories (id, userId, content) VALUES (?, ?, ?)"
    )
      .bind(memoryId, userId, content)
      .run();

    return memoryId;
  }

  async getAllMemories(userId: string) {
    const result = await this.env.DB.prepare(
      "SELECT id, content FROM memories WHERE userId = ? ORDER BY created_at DESC"
    )
      .bind(userId)
      .all();

    return result.results as Array<{ id: string; content: string }>;
  }

  async deleteMemory(memoryId: string, userId: string) {
    await this.env.DB.prepare(
      "DELETE FROM memories WHERE id = ? AND userId = ?"
    )
      .bind(memoryId, userId)
      .run();
  }

  async updateMemory(memoryId: string, userId: string, newContent: string) {
    const result = await this.env.DB.prepare(
      "UPDATE memories SET content = ? WHERE id = ? AND userId = ?"
    )
      .bind(newContent, memoryId, userId)
      .run();

    if (!result.meta || result.meta.changes === 0) {
      throw new Error("Memory not found or unchanged");
    }
  }
}
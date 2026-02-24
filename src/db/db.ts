import { Env } from "hono";

export class DB {
  private static instance: Promise<DB> | null = null;

  private constructor() {}

  static getInstance(env: Env) {
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
    console.log("Init DB");
  }
}
import { Hono } from "hono";
import { MyMCP } from "./mcp/mcp";
import { DB } from "./db/db";
import {
  storeMemory,
  searchMemories,
  updateMemoryVector,
  deleteMemory
} from "./db/vectorize";

const app = new Hono<{ Bindings: Env }>();

/* =====================================
   Middleware: Initialize DB
===================================== */

app.use("*", async (c, next) => {
  await DB.getInstance(c.env);
  await next();
});

/* =====================================
   MEMORY WRITE (DB first, rollback safe)
===================================== */

app.post("/:userId/memory/write", async (c) => {
  const userId = c.req.param("userId");

  try {
    const { content, tier } = await c.req.json();

    if (!content || !tier) {
      return c.json({ success: false, error: "Missing content or tier" }, 400);
    }

    const db = await DB.getInstance(c.env);

    // 1️⃣ Create DB record FIRST (source of truth)
    const memoryId = await db.createMemory({
      userId,
      tier,
      content,
    });

    try {
      // 2️⃣ Index into Vectorize
      await storeMemory(content, userId, tier, c.env, memoryId);
    } catch (vectorErr) {
      // Rollback DB if vector fails
      await db.deleteMemory(memoryId, userId);
      throw vectorErr;
    }

    return c.json({ success: true, id: memoryId });
  } catch (err) {
    console.error("Memory write failed:", err);
    return c.json({ success: false }, 500);
  }
});

/* =====================================
   MEMORY SEARCH
===================================== */

app.post("/:userId/memory/search", async (c) => {
  const userId = c.req.param("userId");

  try {
    const { query, tier } = await c.req.json();

    if (!query || !tier) {
      return c.json({ success: false, error: "Missing query or tier" }, 400);
    }

    const results = await searchMemories(
      query,
      userId,
      tier,
      c.env
    );

    return c.json({ success: true, results });
  } catch (err) {
    console.error("Memory search failed:", err);
    return c.json({ success: false }, 500);
  }
});

/* =====================================
   MEMORY UPDATE (tier from DB only)
===================================== */

app.put("/:userId/memory/:memoryId", async (c) => {
  const userId = c.req.param("userId");
  const memoryId = c.req.param("memoryId");

  try {
    const { content } = await c.req.json();

    if (!content) {
      return c.json({ success: false, error: "Missing content" }, 400);
    }

    const db = await DB.getInstance(c.env);

    // 1️⃣ Fetch canonical record
    const memory = await db.getMemories(userId, "short");
    if (!memory) {
      return c.json({ success: false, error: "Memory not found" }, 404);
    }
    await updateMemoryVector(memoryId, content, userId, "short", c.env);
    return c.json({ success: true });
  } catch (err) {
    console.error("Memory update failed:", err);
    return c.json({ success: false }, 500);
  }
});

/* =====================================
   MEMORY DELETE (vector first safer)
===================================== */

app.delete("/:userId/memory/:memoryId", async (c) => {
  const userId = c.req.param("userId");
  const memoryId = c.req.param("memoryId");

  try {
    const db = await DB.getInstance(c.env);

    const memory = await db.getMemories(userId, "short");
    if (!memory) {
      return c.json({ success: false, error: "Memory not found" }, 404);
    }

    // 1️⃣ Delete from Vector index first
    await deleteMemory(memoryId, c.env);

    // 2️⃣ Then delete from DB
    await db.deleteMemory(memoryId, userId);

    return c.json({ success: true });
  } catch (err) {
    console.error("Memory delete failed:", err);
    return c.json({ success: false }, 500);
  }
});

/* =====================================
   MCP SSE Mount (Proper Param Routing)
===================================== */

app.mount("/", async (req, env, ctx) => {
  // Hono's app.mount handler receives the raw Request, not the Hono Context.
  const url = new URL(req.url);
  // Example path: /someUserId/sse
  const pathSegments = url.pathname.split("/");
  // pathSegments will be ["", "someUserId", "sse"]
  const userId = pathSegments[1];

  if (!userId) {
    // Should not happen with Hono routing matching /:userId/, but good practice
    return new Response("Bad Request: Could not extract userId from URL path", { status: 400 });
  }

  // Pass the dynamic userId to the MCP agent's props
  ctx.props = {
    userId: userId,
  };

  // So the full path handled by MCPMemory will be /:userId/sse
  const response = await MyMCP.mount(`/${userId}/sse`).fetch(req, env, ctx);

  if (response) {
    return response;
  }

  // Fallback if MCPMemory doesn't handle the specific request under its mount point
  return new Response("Not Found within MCP mount", { status: 404 });
});
export default app;
export { MyMCP };
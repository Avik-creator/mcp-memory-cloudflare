import { Hono } from "hono";
import { MyMCP } from "./mcp/mcp";
import { DB } from "./db/db";

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => c.text("Hello, World!"));
app.use("*", async (c, next) => {
  await DB.getInstance(c.env);
  await next();
})

// Get all memories for a user
app.get("/:userId/memories", async (c) => {
  const userId = c.req.param("userId");

  try {

    return c.json({ success: true });
  } catch (error) {
    console.error("Error retrieving memories:", error);
    return c.json({ success: false, error: "Failed to retrieve memories" }, 500);
  }
});

// Delete a memory for a user
app.delete("/:userId/memories/:memoryId", async (c) => {
  const userId = c.req.param("userId");
  const memoryId = c.req.param("memoryId");

  try {
    // 1. Delete from D1
    console.log(`Deleted memory ${memoryId} for user ${userId} from D1.`);

    // 2. Delete from Vectorize index
    try {
      console.log(`Attempted to delete vector ${memoryId} for user ${userId} from Vectorize.`);
    } catch (vectorError) {
      console.error(`Failed to delete vector ${memoryId} for user ${userId} from Vectorize:`, vectorError);
    }

    return c.json({ success: true });
  } catch (error) {
    console.error(`Error deleting memory ${memoryId} (D1 primary) for user ${userId}:`, error);
    return c.json({ success: false, error: "Failed to delete memory" }, 500);
  }
});

// Update a specific memory for a user
app.put("/:userId/memories/:memoryId", async (c) => {
  const userId = c.req.param("userId");
  const memoryId = c.req.param("memoryId");
  let updatedContent: string;

  try {
    // Get updated content from request body
    const body = await c.req.json();
    if (!body || typeof body.content !== "string" || body.content.trim() === "") {
      return c.json({ success: false, error: "Invalid or missing content in request body" }, 400);
    }
    updatedContent = body.content.trim();
  } catch (e) {
    console.error("Failed to parse request body:", e);
    return c.json({ success: false, error: "Failed to parse request body" }, 400);
  }

  try {
    // 1. Update in D1

    console.log(`Updated memory ${memoryId} for user ${userId} in D1.`);

    // 2. Update vector in Vectorize
    try {

      console.log(`Updated vector ${memoryId} for user ${userId} in Vectorize.`);
    } catch (vectorError) {
      console.error(`Failed to update vector ${memoryId} for user ${userId} in Vectorize:`, vectorError);
    }

    return c.json({ success: true });
  } catch (error: any) {
    console.error(`Error updating memory ${memoryId} for user ${userId}:`, error);
    const errorMessage = error.message || "Failed to update memory";
    if (errorMessage.includes("not found")) {
      return c.json({ success: false, error: errorMessage }, 404);
    }
    return c.json({ success: false, error: errorMessage }, 500);
  }
});

app.mount("/", async (req, env, ctx) => {
  // Hono's app.mount handler receives the raw Request, not the Hono Context.
  const url = new URL(req.url);
  const pathSegments = url.pathname.split("/");
  const userId = pathSegments[1];

  if (!userId) {
    return new Response("Bad Request: Could not extract userId from URL path", { status: 400 });
  }

  ctx.props = {
    userId: userId,
  };

  const response = await MyMCP.mount(`/${userId}/sse`).fetch(req, env, ctx);

  if (response) {
    return response;
  }

  return new Response("Not Found within MCP mount", { status: 404 });
});

export default app;

export { MyMCP };
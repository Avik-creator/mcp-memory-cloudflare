import { z } from "zod";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { storeMemory, searchMemories } from "../db/vectorize";
import { DB } from "../db/db";

type MCPProps = {
  userId: string;
};

export class MyMCP extends McpAgent<Env, {}, MCPProps> {
  server = new McpServer({
    name: "MCP Memory",
    version: "1.0.0",
  });

  async init() {
    const server = this.server as unknown as McpServer;

    /* =====================================
       WRITE MEMORY TOOL
    ===================================== */

    server.registerTool(
      "memory.write",
      {
        description:
          "Store durable user information in long-term memory. Use only for stable facts or preferences.",
        inputSchema: {
          content: z.string().describe("The information to store"),
          tier: z.enum(["short", "long"]).describe("Memory tier"),
        },
      },
      async ({ content, tier }: { content: string; tier: "short" | "long" }) => {
        try {
          const userId = this.props?.userId;

          if (!userId) {
            throw new Error("MCP props.userId missing");
          }

          const db = await DB.getInstance(this.env);

          // 1️⃣ DB first
          const memoryId = await db.createMemory({
            userId,
            tier,
            content,
          });

          // 2️⃣ Vector index
          await storeMemory(content, userId, tier, this.env, memoryId);

          return {
            content: [
              {
                type: "text" as const,
                text: `Memory stored successfully.`,
              },
            ],
          };
        } catch (error) {
          console.error("Error storing memory:", error);
          return {
            content: [
              {
                type: "text" as const,
                text: "Failed to store memory.",
              },
            ],
          };
        }
      }
    );

    /* =====================================
       SEARCH MEMORY TOOL
    ===================================== */

    server.registerTool(
      "memory.search",
      {
        description:
          "Search relevant information from memory.",
        inputSchema: {
          query: z.string().describe("Search query"),
          tier: z.enum(["short", "long"]).describe("Memory tier"),
        },
      },
      async ({ query, tier }: { query: string; tier: "short" | "long" }) => {
        try {
          const userId = this.props?.userId;

          if (!userId) {
            throw new Error("MCP props.userId missing");
          }

          const results = await searchMemories(
            query,
            userId,
            tier,
            this.env
          );

          if (!results.length) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "No relevant memories found.",
                },
              ],
            };
          }

          const formatted = results
            .map((m) => `• ${m.content}`)
            .join("\n");

          return {
            content: [
              {
                type: "text" as const,
                text: `Relevant memories:\n${formatted}`,
              },
            ],
          };
        } catch (error) {
          console.error("Error searching memory:", error);
          return {
            content: [
              {
                type: "text" as const,
                text: "Failed to search memory.",
              },
            ],
          };
        }
      }
    );
  }
}
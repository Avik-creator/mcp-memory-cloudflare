import { z } from "zod";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { storeMemory, searchMemories, updateMemoryVector, deleteMemory as deleteVectorMemory, generateEmbeddings } from "../db/vectorize";
import { DB } from "../db/db";

const TEXT_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";

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
      "memory_write",
      {
        description:
          "Store durable user information in long-term memory. Use only for stable facts or preferences.",
        inputSchema: {
          content: z.string().describe("The information to store"),
          tier: z.enum(["short", "long"]).describe("Memory tier"),
          importance: z.number().min(0).max(1).optional().describe("Importance score 0-1"),
          source: z.string().optional().describe("Source of the memory"),
        },
      },
      async ({ content, tier, importance, source }: { content: string; tier: "short" | "long"; importance?: number; source?: string }) => {
        try {
          const userId = this.props?.userId;

          if (!userId) {
            throw new Error("MCP props.userId missing");
          }

          const db = await DB.getInstance(this.env);

          const memoryId = await db.createMemory({
            userId,
            tier,
            content,
            importance,
            source,
          });

          await storeMemory(content, userId, tier, this.env, memoryId);

          return {
            content: [
              {
                type: "text" as const,
                text: `Memory stored successfully with ID: ${memoryId}`,
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
       BATCH WRITE MEMORY TOOL
    ===================================== */

    server.registerTool(
      "memory_batch_write",
      {
        description:
          "Store multiple memories at once. More efficient than multiple single writes.",
        inputSchema: {
          memories: z.array(z.object({
            content: z.string().describe("The information to store"),
            tier: z.enum(["short", "long"]).describe("Memory tier"),
            importance: z.number().min(0).max(1).optional().describe("Importance score 0-1"),
          })).min(1).max(50).describe("Array of memories to store"),
        },
      },
      async ({ memories }: { memories: Array<{ content: string; tier: "short" | "long"; importance?: number }> }) => {
        try {
          const userId = this.props?.userId;

          if (!userId) {
            throw new Error("MCP props.userId missing");
          }

          const db = await DB.getInstance(this.env);

          const rows = memories.map((m) => ({
            id: `${userId}:${m.tier}:${crypto.randomUUID()}`,
            userId,
            tier: m.tier,
            content: m.content,
            importance: m.importance,
          }));

          const memoryIds = await db.batchCreateMemories(
            rows
          );

          const embeddings = await generateEmbeddings(
            memories.map((m) => m.content),
            this.env
          );

          const vectorInserts = memories.map((m, i) => {
            const id = memoryIds[i];
            return {
              id,
              values: embeddings[i],
              namespace: `${userId}:${m.tier}`,
              metadata: {
                userId,
                tier: m.tier,
                content: m.content,
                createdAt: Date.now(),
              },
            };
          });

          await this.env.VECTORIZE.insert(vectorInserts);

          return {
            content: [
              {
                type: "text" as const,
                text: `Successfully stored ${memories.length} memories.`,
              },
            ],
          };
        } catch (error) {
          console.error("Error batch storing memories:", error);
          return {
            content: [
              {
                type: "text" as const,
                text: "Failed to batch store memories.",
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
      "memory_search",
      {
        description:
          "Search relevant information from memory.",
        inputSchema: {
          query: z.string().describe("Search query"),
          tier: z.enum(["short", "long"]).describe("Memory tier"),
          limit: z.number().min(1).max(50).optional().describe("Max results to return"),
        },
      },
      async ({ query, tier, limit }: { query: string; tier: "short" | "long"; limit?: number }) => {
        try {
          const userId = this.props?.userId;

          if (!userId) {
            throw new Error("MCP props.userId missing");
          }

          const results = await searchMemories(
            query,
            userId,
            tier,
            this.env,
            limit ?? 10
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
            .map((m, i) => `${i + 1}. [Score: ${m.score.toFixed(3)}] ${m.content}`)
            .join("\n");

          return {
            content: [
              {
                type: "text" as const,
                text: `Found ${results.length} relevant memories:\n${formatted}`,
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

    /* =====================================
       LIST MEMORIES TOOL
    ===================================== */

    server.registerTool(
      "memory_list",
      {
        description:
          "List all stored memories for the user.",
        inputSchema: {
          tier: z.enum(["short", "long"]).optional().describe("Filter by tier (optional)"),
        },
      },
      async ({ tier }: { tier?: "short" | "long" }) => {
        try {
          const userId = this.props?.userId;

          if (!userId) {
            throw new Error("MCP props.userId missing");
          }

          const db = await DB.getInstance(this.env);

          let memories;
          if (tier) {
            memories = await db.getMemories(userId, tier);
          } else {
            memories = await db.getAllMemories(userId);
          }

          if (!memories.length) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "No memories found.",
                },
              ],
            };
          }

          const formatted = (memories as Array<{ id: string; tier?: string; content: string; created_at: number }>)
            .map((m, i) => {
              const date = new Date(m.created_at).toISOString().split("T")[0];
              const tierLabel = m.tier ? `[${m.tier}]` : "";
              return `${i + 1}. ${tierLabel} ${m.content.substring(0, 100)}${m.content.length > 100 ? "..." : ""} (${date})`;
            })
            .join("\n");

          return {
            content: [
              {
                type: "text" as const,
                text: `Found ${memories.length} memories:\n${formatted}`,
              },
            ],
          };
        } catch (error) {
          console.error("Error listing memories:", error);
          return {
            content: [
              {
                type: "text" as const,
                text: "Failed to list memories.",
              },
            ],
          };
        }
      }
    );

    /* =====================================
       UPDATE MEMORY TOOL
    ===================================== */

    server.registerTool(
      "memory_update",
      {
        description:
          "Update an existing memory by ID.",
        inputSchema: {
          memoryId: z.string().describe("ID of the memory to update"),
          content: z.string().describe("New content for the memory"),
        },
      },
      async ({ memoryId, content }: { memoryId: string; content: string }) => {
        try {
          const userId = this.props?.userId;

          if (!userId) {
            throw new Error("MCP props.userId missing");
          }

          const db = await DB.getInstance(this.env);

          const memory = await db.getMemoryById(memoryId, userId);
          if (!memory) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Memory not found.",
                },
              ],
            };
          }

          const tier = (memory as { tier: "short" | "long" }).tier;

          await db.updateMemory(memoryId, userId, content);

          await updateMemoryVector(memoryId, content, userId, tier, this.env);

          return {
            content: [
              {
                type: "text" as const,
                text: "Memory updated successfully.",
              },
            ],
          };
        } catch (error) {
          console.error("Error updating memory:", error);
          return {
            content: [
              {
                type: "text" as const,
                text: "Failed to update memory.",
              },
            ],
          };
        }
      }
    );

    /* =====================================
       DELETE MEMORY TOOL
    ===================================== */

    server.registerTool(
      "memory_delete",
      {
        description:
          "Delete a specific memory by ID.",
        inputSchema: {
          memoryId: z.string().describe("ID of the memory to delete"),
        },
      },
      async ({ memoryId }: { memoryId: string }) => {
        try {
          const userId = this.props?.userId;

          if (!userId) {
            throw new Error("MCP props.userId missing");
          }

          const db = await DB.getInstance(this.env);

          const memory = await db.getMemoryById(memoryId, userId);
          if (!memory) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Memory not found.",
                },
              ],
            };
          }

          await deleteVectorMemory(memoryId, this.env);

          await db.deleteMemory(memoryId, userId);

          return {
            content: [
              {
                type: "text" as const,
                text: "Memory deleted successfully.",
              },
            ],
          };
        } catch (error) {
          console.error("Error deleting memory:", error);
          return {
            content: [
              {
                type: "text" as const,
                text: "Failed to delete memory.",
              },
            ],
          };
        }
      }
    );

    /* =====================================
       CLEAR MEMORIES TOOL
    ===================================== */

    server.registerTool(
      "memory_clear",
      {
        description:
          "Clear all memories, optionally filtered by tier. Use with caution.",
        inputSchema: {
          tier: z.enum(["short", "long"]).optional().describe("Only clear memories of this tier (optional)"),
          confirm: z.boolean().describe("Must be true to confirm deletion"),
        },
      },
      async ({ tier, confirm }: { tier?: "short" | "long"; confirm: boolean }) => {
        try {
          const userId = this.props?.userId;

          if (!userId) {
            throw new Error("MCP props.userId missing");
          }

          if (!confirm) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Deletion not confirmed. Set confirm=true to proceed.",
                },
              ],
            };
          }

          const db = await DB.getInstance(this.env);

          const count = await db.getMemoryCount(userId, tier);

          if (tier) {
            const memories = await db.getAllMemories(userId, tier);
            const ids = (memories as Array<{ id: string }>).map((m) => m.id);
            if (ids.length > 0) {
              await this.env.VECTORIZE.deleteByIds(ids);
            }
          } else {
            const allMemories = await db.getAllMemories(userId);
            const ids = (allMemories as Array<{ id: string }>).map((m) => m.id);
            if (ids.length > 0) {
              await this.env.VECTORIZE.deleteByIds(ids);
            }
          }

          await db.clearAllMemories(userId, tier);

          return {
            content: [
              {
                type: "text" as const,
                text: `Cleared ${count} memories${tier ? ` from ${tier}-term memory` : ""}.`,
              },
            ],
          };
        } catch (error) {
          console.error("Error clearing memories:", error);
          return {
            content: [
              {
                type: "text" as const,
                text: "Failed to clear memories.",
              },
            ],
          };
        }
      }
    );

    /* =====================================
       MEMORY STATS TOOL
    ===================================== */

    server.registerTool(
      "memory_stats",
      {
        description:
          "Get statistics about stored memories.",
        inputSchema: {},
      },
      async () => {
        try {
          const userId = this.props?.userId;

          if (!userId) {
            throw new Error("MCP props.userId missing");
          }

          const db = await DB.getInstance(this.env);

          const [totalCount, shortCount, longCount] = await Promise.all([
            db.getMemoryCount(userId),
            db.getMemoryCount(userId, "short"),
            db.getMemoryCount(userId, "long"),
          ]);

          return {
            content: [
              {
                type: "text" as const,
                text: `Memory Statistics:\n- Total: ${totalCount}\n- Short-term: ${shortCount}\n- Long-term: ${longCount}`,
              },
            ],
          };
        } catch (error) {
          console.error("Error getting memory stats:", error);
          return {
            content: [
              {
                type: "text" as const,
                text: "Failed to get memory stats.",
              },
            ],
          };
        }
      }
    );

    /* =====================================
       AI SUMMARIZE TOOL
    ===================================== */

    server.registerTool(
      "memory_summarize",
      {
        description:
          "Use AI to summarize all memories or a specific tier.",
        inputSchema: {
          tier: z.enum(["short", "long"]).optional().describe("Memory tier to summarize (optional)"),
        },
      },
      async ({ tier }: { tier?: "short" | "long" }) => {
        try {
          const userId = this.props?.userId;

          if (!userId) {
            throw new Error("MCP props.userId missing");
          }

          const db = await DB.getInstance(this.env);

          let memories;
          if (tier) {
            memories = await db.getMemories(userId, tier);
          } else {
            memories = await db.getAllMemories(userId);
          }

          if (!memories.length) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "No memories to summarize.",
                },
              ],
            };
          }

          const content = (memories as Array<{ content: string }>)
            .map((m) => m.content)
            .join("\n");

          const summary = await this.env.AI.run(TEXT_MODEL, {
            messages: [
              {
                role: "system",
                content: "You are a helpful assistant that summarizes user memories. Create a concise summary of the key facts and information.",
              },
              {
                role: "user",
                content: `Summarize these memories:\n${content}`,
              },
            ],
          }) as { response?: string };

          return {
            content: [
              {
                type: "text" as const,
                text: `Summary of ${memories.length} memories:\n${summary.response ?? "Failed to generate summary"}`,
              },
            ],
          };
        } catch (error) {
          console.error("Error summarizing memories:", error);
          return {
            content: [
              {
                type: "text" as const,
                text: "Failed to summarize memories.",
              },
            ],
          };
        }
      }
    );

    /* =====================================
       AI EXTRACT ENTITIES TOOL
    ===================================== */

    server.registerTool(
      "memory_extract_entities",
      {
        description:
          "Use AI to extract named entities (people, places, dates, etc.) from memories.",
        inputSchema: {
          tier: z.enum(["short", "long"]).optional().describe("Memory tier to analyze (optional)"),
        },
      },
      async ({ tier }: { tier?: "short" | "long" }) => {
        try {
          const userId = this.props?.userId;

          if (!userId) {
            throw new Error("MCP props.userId missing");
          }

          const db = await DB.getInstance(this.env);

          let memories;
          if (tier) {
            memories = await db.getMemories(userId, tier);
          } else {
            memories = await db.getAllMemories(userId);
          }

          if (!memories.length) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "No memories to analyze.",
                },
              ],
            };
          }

          const content = (memories as Array<{ content: string }>)
            .map((m) => m.content)
            .join("\n");

          const result = await this.env.AI.run(TEXT_MODEL, {
            messages: [
              {
                role: "system",
                content: "You are an entity extraction specialist. Extract all named entities from the text. Format as JSON with categories: people, places, organizations, dates, and other.",
              },
              {
                role: "user",
                content: `Extract entities from:\n${content}\n\nRespond only with valid JSON.`,
              },
            ],
          }) as { response?: string };

          return {
            content: [
              {
                type: "text" as const,
                text: `Extracted entities:\n${result.response ?? "Failed to extract entities"}`,
              },
            ],
          };
        } catch (error) {
          console.error("Error extracting entities:", error);
          return {
            content: [
              {
                type: "text" as const,
                text: "Failed to extract entities.",
              },
            ],
          };
        }
      }
    );

    /* =====================================
       AI ASK TOOL
    ===================================== */

    server.registerTool(
      "memory_ask",
      {
        description:
          "Ask a question about stored memories using AI with RAG context.",
        inputSchema: {
          question: z.string().describe("Question to ask about memories"),
          tier: z.enum(["short", "long"]).optional().describe("Memory tier to search (optional)"),
        },
      },
      async ({ question, tier }: { question: string; tier?: "short" | "long" }) => {
        try {
          const userId = this.props?.userId;

          if (!userId) {
            throw new Error("MCP props.userId missing");
          }

          const searchTier = tier ?? "long";
          const results = await searchMemories(question, userId, searchTier, this.env, 5);

          const context = results.map((r) => r.content).join("\n");

          const answer = await this.env.AI.run(TEXT_MODEL, {
            messages: [
              {
                role: "system",
                content: "You are a helpful assistant that answers questions based on the user's stored memories. Use the provided context to give accurate answers. If the context doesn't contain relevant information, say so.",
              },
              {
                role: "user",
                content: `Context from memories:\n${context}\n\nQuestion: ${question}`,
              },
            ],
          }) as { response?: string };

          return {
            content: [
              {
                type: "text" as const,
                text: answer.response ?? "Failed to generate answer",
              },
            ],
          };
        } catch (error) {
          console.error("Error answering question:", error);
          return {
            content: [
              {
                type: "text" as const,
                text: "Failed to answer question.",
              },
            ],
          };
        }
      }
    );
  }
}

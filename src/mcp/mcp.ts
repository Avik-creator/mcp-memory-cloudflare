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
          "Store durable user information in persistent memory with optional metadata. Use this tool when you need to save important facts, preferences, settings, or context about the user that should be retained across conversations. Supports both short-term (temporary, session-based) and long-term (persistent) memory tiers. Include an importance score (0-1) to indicate how critical the memory is for future interactions.",
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
          "Efficiently store multiple memories in a single operation. Use this tool when you need to save 2 or more related pieces of information simultaneously (e.g., extracting and storing multiple facts from a conversation, importing bulk information). This is significantly more efficient than calling memory_write repeatedly. Supports up to 50 memories per batch, each with independent tier and importance settings.",
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
          "Search for relevant memories using semantic similarity to find contextually related information. Use this tool to retrieve memories that match a query's meaning rather than exact keywords. Useful for answering questions about what you know about a user, finding related context, or retrieving relevant facts without knowing exact wording. Returns ranked results with relevance scores. Specify tier to search only short-term or long-term memories.",
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
          "Retrieve a list of all stored memories with optional filtering by tier. Use this tool to browse or audit the user's stored memories, see what information is available, or get a complete inventory of short-term vs long-term memories. Returns memories with creation dates and content previews. Optionally filter by tier (short or long) to view only one memory category.",
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
          "Update the content of an existing memory while preserving its ID and metadata. Use this tool to correct, clarify, or enhance previously stored information. The memory vector embeddings are automatically recalculated to maintain semantic search accuracy. Useful for refining memories based on new information or correcting inaccuracies.",
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
          "Permanently delete a specific memory by its ID. Use this tool to remove outdated, incorrect, or irrelevant information from memory. The deletion is permanent and removes the memory from both the database and vector store. Always obtain the memory ID from memory_list or memory_search before deleting.",
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
          "Batch delete all memories, optionally filtered by tier. Use this tool for cleanup operations when you need to remove all stored memories or reset one memory tier. This operation is permanent and cannot be undone. Requires explicit confirmation (confirm=true) to prevent accidental data loss. Useful for memory resets, tier-specific cleanup, or managing memory storage limits.",
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
          "Retrieve statistics about the user's stored memories including total count and breakdown by tier (short-term vs long-term). Use this tool to monitor memory usage, understand the distribution of stored information, or check memory storage status. Returns counts for total memories, short-term memories, and long-term memories.",
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
          "Use AI to generate a concise summary of stored memories. Use this tool to condense large amounts of information into key points, understand the main themes in the user's memories, or create executive summaries of stored context. Optionally filter by tier to summarize only short-term or long-term memories. Helpful for reviewing what you know about a user or creating context summaries.",
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
          "Use AI-powered named entity recognition to extract structured information from memories including people, places, organizations, dates, and other important entities. Use this tool to automatically categorize and organize the semantic content of stored memories, identify key individuals or locations mentioned, or create structured knowledge from unstructured memory text. Returns entities organized by category as JSON.",
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
          "Ask natural language questions about stored memories using AI with Retrieval-Augmented Generation (RAG). The system automatically searches relevant memories and uses them as context to answer questions accurately. Use this tool to query information from memory without needing exact knowledge of what's stored, get answers based on user context, or perform semantic reasoning over stored information. Optionally specify memory tier to search.",
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

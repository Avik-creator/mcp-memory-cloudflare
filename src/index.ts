import { Env } from "hono";
import { z } from "zod";
import { McpAgent} from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

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
    server.registerTool(
      "addToMCPMemory",
      {
        description: "This tool stores important user information in a persistent memory layer.",
        inputSchema: { thingToRemember: z.string().describe("The information to store in memory") },
      },
      async ({ thingToRemember }: { thingToRemember: string }) => { 
        try {
          return {
            content: [{ type: "text" as const, text: `Remembered: ${thingToRemember}` }],
          };
        } catch (error) {
          console.error("Error storing memory:", error);
          return {
            content: [{ type: "text" as const, text: "Failed to remember: " + String(error) }],
          };
        }
      }
    );
    server.registerTool(
      "searchMCPMemory",
      {
        description: "This tool retrieves information from the persistent memory layer based on a search query.",
        inputSchema: { query: z.string().describe("The search query to find relevant memories") },
      },
      async ({informationToSearch}: { informationToSearch: string }) => {
        try{
          console.log("Searching memory for query:", informationToSearch);

          return {
            
          }
        }
      }
    )
  }
}
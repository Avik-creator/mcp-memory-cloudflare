# MCP Memory Server on Cloudflare Workers

A production-ready Model Context Protocol (MCP) memory management server deployed on Cloudflare Workers. This server provides persistent memory storage with vector embeddings for intelligent semantic search, enabling AI agents to maintain contextual information across sessions.

## Features

- **Durable Memory Storage**: Two-tier memory system (short-term and long-term) with Cloudflare D1
- **Vector Search**: Semantic search using Cloudflare Vectorize with embeddings
- **MCP Integration**: Full Model Context Protocol support for AI agents and assistants
- **REST API**: HTTP endpoints for direct memory operations
- **Rollback Safety**: DB-first writes with automatic rollback on vector indexing failures
- **Rate Limiting**: Built-in rate limiting with configurable thresholds
- **TypeScript**: Fully typed codebase with zero runtime configuration

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│           Cloudflare Worker (Hono)                      │
├─────────────────────────────────────────────────────────┤
│  ┌──────────────────┐      ┌──────────────────┐        │
│  │  MCP Server      │      │  REST API        │        │
│  │  (MCP Tools)     │      │  (HTTP Routes)   │        │
│  └────────┬─────────┘      └────────┬─────────┘        │
│           │                         │                  │
│           └────────────┬────────────┘                  │
│                        │                               │
│                  ┌─────▼─────┐                         │
│                  │ Vectorize  │                         │
│                  │ DB Module  │                         │
│                  └─────┬─────┘                         │
└─────────────────────────┼───────────────────────────────┘
                          │
        ┌─────────────────┼─────────────────┐
        │                 │                 │
    ┌───▼────┐      ┌────▼────┐      ┌────▼─────┐
    │ D1 DB  │      │Vectorize │      │Rate Limit│
    │(Memory)│      │(Embeddings)│     │Namespace │
    └────────┘      └──────────┘      └──────────┘
```

## Project Structure

```
src/
├── index.ts          # Main Hono application & REST endpoints
├── mcp/
│   └── mcp.ts        # MCP server implementation & tools
└── db/
    ├── db.ts         # D1 database interface
    └── vectorize.ts  # Vector embeddings & semantic search
```

## Quick Start

### Prerequisites

- Node.js 18+
- Cloudflare account with Workers, D1, and Vectorize enabled
- `wrangler` CLI installed

### Installation

```bash
npm install
```

### Development

Start the local development server:

```bash
npm run dev
```

The server will run at `http://localhost:8787`

### Generate Cloudflare Bindings

Sync types with your Cloudflare Worker configuration:

```bash
npm run cf-typegen
```

This generates the `CloudflareBindings` types based on your `wrangler.jsonc` configuration.

### Deploy to Production

Deploy to Cloudflare Workers:

```bash
npm run deploy
```

## API Endpoints

### Write Memory

```http
POST /:userId/memory/write
```

**Request Body:**
```json
{
  "content": "User information to remember",
  "tier": "long",
  "importance": 0.8,
  "source": "optional source identifier"
}
```

**Response:**
```json
{
  "success": true,
  "memoryId": "uuid",
  "content": "..."
}
```

### Search Memories

```http
GET /:userId/memory/search?query=search+term&limit=10
```

**Response:**
```json
{
  "results": [
    {
      "id": "uuid",
      "content": "...",
      "score": 0.95,
      "tier": "long"
    }
  ]
}
```

### Update Memory

```http
PUT /:userId/memory/:memoryId
```

**Request Body:**
```json
{
  "content": "Updated content",
  "importance": 0.9
}
```

### Delete Memory

```http
DELETE /:userId/memory/:memoryId
```

## MCP Tools

The MCP server exposes the following tools:

- **`memory_write`**: Store information with optional metadata
- **`memory_search`**: Semantic search across memories
- **`memory_update`**: Modify existing memory entries
- **`memory_delete`**: Remove memory entries
- **`memory_batch_write`**: Write multiple memories efficiently

Each tool includes input validation with Zod schemas and comprehensive error handling.

## Configuration

### Cloudflare Bindings (wrangler.jsonc)

The project uses the following Cloudflare services:

- **D1 Database**: `DB` binding for persistent storage
- **Vectorize**: `VECTORIZE` binding for semantic search
- **Durable Objects**: `MCP_OBJECT` for stateful operations (if needed)
- **Rate Limiting**: `RATE_LIMITER` with 100 requests per 60 seconds

Update `wrangler.jsonc` to customize these bindings or thresholds.

## Deployment Notes

- The production D1 database and Vectorize index are already configured
- Environment: `production` (configured in wrangler.jsonc)
- All bindings are bound to remote Cloudflare resources
- Rate limiting is enabled by default to prevent abuse

## Environment Setup

Ensure your Cloudflare account has:

1. ✅ D1 Database created: `mcp-memory-db`
2. ✅ Vectorize index created: `mcp-memory-vectorize`
3. ✅ Workers enabled with appropriate permissions
4. ✅ Wrangler authenticated: `wrangler login`

## Troubleshooting

**Port already in use?**
The dev server uses port 8787 by default. Specify a different port:
```bash
wrangler dev --ip 0.0.0.0 --port 8788
```

**Type errors in TypeScript?**
Regenerate bindings:
```bash
npm run cf-typegen
```

**Vectorize queries returning no results?**
Ensure memories are being written to Cloudflare Vectorize before searching. Check the database logs in the Cloudflare dashboard.

## Development Tips

- Use `wrangler tail` to stream live logs from your production Worker
- Monitor metrics in the Cloudflare dashboard under Workers Analytics
- Test MCP tools using the agents library test utilities
- Keep memory tier strategy consistent (short-term for ephemeral, long-term for persistent)

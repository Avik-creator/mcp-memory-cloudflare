import { v4 as uuidv4 } from "uuid";

/* ================================
   CONFIG
================================ */

export type MemoryTier = "short" | "long";

export type MemoryConfig = {
  duplicateThreshold: number;
  searchThreshold: number;
  recencyWeight: number;
  recencyHalfLifeMs: number;
};

const DEFAULT_CONFIG: MemoryConfig = {
  duplicateThreshold: 0.85,
  searchThreshold: 0.65,
  recencyWeight: 0.1,
  recencyHalfLifeMs: 1000 * 60 * 60 * 24 * 3, // 3 days
};

/* ================================
   TYPES
================================ */

type MemoryMetadata = {
  userId: string;
  tier: MemoryTier;
  content: string;
  createdAt: number;
  updatedAt?: number;
  importance?: number;
  source?: string;
};

export type MemoryResult = {
  id: string;
  content: string;
  score: number;
};

/* ================================
   EMBEDDINGS
================================ */

export async function generateEmbeddings(
  texts: string | string[],
  env: Env
): Promise<number[][]> {
  const input = Array.isArray(texts) ? texts : [texts];
  const cleaned = input.map(t => t.trim());

  const res = await env.AI.run("@cf/baai/bge-m3", {
    text: cleaned,
  }) as AiTextEmbeddingsOutput;

  if (!res.data?.length) {
    throw new Error("Embedding generation failed");
  }

  return res.data;
}

/* ================================
   STORE MEMORY
================================ */

export async function storeMemory(
  content: string,
  userId: string,
  tier: MemoryTier,
  env: Env,
  config: MemoryConfig = DEFAULT_CONFIG
): Promise<string> {
  const namespace = `${userId}:${tier}`;
  const memoryId = `${userId}:${tier}:${uuidv4()}`;

  const [vector] = await generateEmbeddings(content, env);
  if (!vector) throw new Error("Invalid embedding");

  // dedupe check
  const similar = await env.VECTORIZE.query(vector, {
    namespace,
    topK: 1,
    returnMetadata: true,
  });

  const top = similar.matches?.[0];

  if (top && (top.score ?? 0) >= config.duplicateThreshold) {
    await updateMemoryVector(
      top.id,
      content,
      userId,
      tier,
      env,
      top.metadata as MemoryMetadata,
      config
    );
    return top.id;
  }

  const metadata: MemoryMetadata = {
    userId,
    tier,
    content,
    createdAt: Date.now(),
  };

  try {
    await env.VECTORIZE.insert([
      {
        id: memoryId,
        values: vector,
        namespace,
        metadata,
      },
    ]);
  } catch (err) {
    console.error("Vector insert failed", { userId, tier, err });
    throw err;
  }

  return memoryId;
}

/* ================================
   SEARCH
================================ */

export async function searchMemories(
  query: string,
  userId: string,
  tier: MemoryTier,
  env: Env,
  topK: number = 10,
  config: MemoryConfig = DEFAULT_CONFIG
): Promise<MemoryResult[]> {
  const namespace = `${userId}:${tier}`;
  const [queryVector] = await generateEmbeddings(query, env);

  if (!queryVector) throw new Error("Invalid query embedding");

  const results = await env.VECTORIZE.query(queryVector, {
    namespace,
    topK,
    returnMetadata: true,
  });

  if (!results.matches?.length) return [];

  const now = Date.now();

  const memories = results.matches
    .map(match => {
      const meta = match.metadata as MemoryMetadata | undefined;
      const semantic = match.score ?? 0;

      if (!meta?.content || semantic < config.searchThreshold) {
        return null;
      }

      const age = now - meta.createdAt;
      const recency = Math.exp(-age / config.recencyHalfLifeMs);

      // multiplicative recency
      const finalScore =
        semantic * (1 + recency * config.recencyWeight);

      return {
        id: match.id,
        content: meta.content,
        score: finalScore,
      };
    })
    .filter(Boolean) as MemoryResult[];

  memories.sort((a, b) => b.score - a.score);
  return memories;
}

/* ================================
   UPDATE
================================ */

export async function updateMemoryVector(
  memoryId: string,
  newContent: string,
  userId: string,
  tier: MemoryTier,
  env: Env,
  previous?: MemoryMetadata,
  config: MemoryConfig = DEFAULT_CONFIG
): Promise<void> {
  const namespace = `${userId}:${tier}`;
  const [vector] = await generateEmbeddings(newContent, env);
  if (!vector) throw new Error("Invalid embedding");

  const metadata: MemoryMetadata = {
    userId,
    tier,
    content: newContent,
    createdAt: previous?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
    importance: previous?.importance,
    source: previous?.source,
  };

  try {
    await env.VECTORIZE.upsert([
      {
        id: memoryId,
        values: vector,
        namespace,
        metadata,
      },
    ]);
  } catch (err) {
    console.error("Vector upsert failed", { memoryId, err });
    throw err;
  }
}

/* ================================
   DELETE
================================ */

export async function deleteMemory(
  memoryId: string,
  env: Env
): Promise<void> {
  try {
    await env.VECTORIZE.deleteByIds([memoryId]);
  } catch (err) {
    console.error("Vector delete failed", { memoryId, err });
    throw err;
  }
}
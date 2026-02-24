import { v4 as uuidv4 } from "uuid";

const DUPLICATE_THRESHOLD = 0.7;
const SEARCH_THRESHOLD = 0.65;         // usable relevance
const RECENCY_HALF_LIFE = 1000 * 60 * 60 * 24 * 3; // 3 days

type MemoryTier = "short" | "long";

type MemoryMetadata = {
  userId: string;
  content: string;
  createdAt: number;
  updatedAt?: number;
  importance?: number;   // optional future scoring
  source?: string;       // chat/tool/system
};

type MemoryResult = {
  id: string;
  content: string;
  score: number;
};

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

export async function storeMemory(
  content: string,
  userId: string,
  tier: MemoryTier,
  env: Env
): Promise<string> {
  const namespace = `${userId}:${tier}`;
  const [vector] = await generateEmbeddings(content, env);

  if (!vector) throw new Error("Invalid embedding vector");

  // Check near-duplicate
  const similar = await env.VECTORIZE.query(vector, {
    namespace,
    topK: 1,
    returnMetadata: true,
  });

  const topMatch = similar.matches?.[0];

  if (topMatch && (topMatch.score ?? 0) >= DUPLICATE_THRESHOLD) {
    // Update instead of skipping
    await updateMemoryVector(
      topMatch.id,
      content,
      userId,
      tier,
      env,
      topMatch.metadata as MemoryMetadata
    );
    return topMatch.id;
  }

  const memoryID = uuidv4();

  const metadata: MemoryMetadata = {
    userId,
    content,
    createdAt: Date.now(),
  };

  await env.VECTORIZE.insert([
    {
      id: memoryID,
      values: vector,
      namespace,
      metadata,
    },
  ]);

  return memoryID;
}

export async function searchMemories(
  query: string,
  userId: string,
  tier: MemoryTier,
  env: Env,
  topK: number = 10
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
      const semanticScore = match.score ?? 0;

      if (!meta?.content || semanticScore < SEARCH_THRESHOLD) {
        return null;
      }

      // Recency boost (exponential decay)
      const age = now - meta.createdAt;
      const recencyBoost = Math.exp(-age / RECENCY_HALF_LIFE);

      const finalScore = semanticScore + recencyBoost * 0.15;

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

export async function updateMemoryVector(
  memoryId: string,
  newContent: string,
  userId: string,
  tier: MemoryTier,
  env: Env,
  previousMetadata?: MemoryMetadata
): Promise<void> {
  const namespace = `${userId}:${tier}`;
  const [newVector] = await generateEmbeddings(newContent, env);

  if (!newVector) throw new Error("Invalid embedding vector");

  const metadata: MemoryMetadata = {
    userId,
    content: newContent,
    createdAt: previousMetadata?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
    importance: previousMetadata?.importance,
    source: previousMetadata?.source,
  };

  await env.VECTORIZE.upsert([
    {
      id: memoryId,
      values: newVector,
      namespace,
      metadata,
    },
  ]);
}

export async function deleteMemory(
  memoryId: string,
  userId: string,
  tier: MemoryTier,
  env: Env
): Promise<void> {
  try {
    await env.VECTORIZE.deleteByIds([memoryId]);
    console.log(`Vector ID ${memoryId} deleted from Vectorize namespace ${userId}`);
  } catch (error) {
    console.error(`Error deleting vector ID ${memoryId} from Vectorize namespace ${userId}:`, error);
  }
}
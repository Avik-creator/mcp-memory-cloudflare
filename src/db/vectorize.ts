import { v4 as uuidv4 } from "uuid";

const MINIMUM_SIMILARITY_SCORE = 0.7;
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
  env: Env
): Promise<string> {
  const memoryID = uuidv4();

  const [vector] = await generateEmbeddings(content, env);

  // check similar memories
  const similar = await env.VECTORIZE.query(vector, {
    namespace: userId,
    topK: 1
  });

  if (similar.matches?.[0]?.score > MINIMUM_SIMILARITY_SCORE) {
    return similar.matches[0].id; // don't duplicate
  }

  await env.VECTORIZE.insert([{
    id: memoryID,
    values: vector,
    namespace: userId,
    metadata: {
      userId,
      content,
      createdAt: Date.now()
    }
  }]);

  return memoryID;
}
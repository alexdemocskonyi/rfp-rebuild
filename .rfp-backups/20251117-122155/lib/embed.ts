// lib/embed.ts
import OpenAI from "openai";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

export async function getEmbedding(text: string): Promise<number[]> {
  const clean = (text || "").trim();
  if (!clean) return [];
  try {
    const res = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: clean.slice(0, 8000),
    });
    const emb = res.data?.[0]?.embedding || [];
    return Array.isArray(emb) ? emb.map((n: any) => Number(n) || 0) : [];
  } catch (err: any) {
    console.error("❌ EMBED_ERROR", err?.message || err);
    return [];
  }
}

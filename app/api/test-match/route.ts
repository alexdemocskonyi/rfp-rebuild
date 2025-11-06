import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

function cosineSim(a: number[], b: number[]) {
  const dot = a.reduce((sum, v, i) => sum + v * b[i], 0);
  const normA = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
  const normB = Math.sqrt(b.reduce((s, v) => s + v * v, 0));
  return dot / (normA * normB);
}

async function getEmbedding(query: string): Promise<number[]> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: query,
      model: "text-embedding-3-small"
    })
  });
  const data = await res.json();
  if (!data.data || !data.data[0]) throw new Error("Failed to embed query");
  return data.data[0].embedding;
}

export async function POST(req: NextRequest) {
  try {
    const { query } = await req.json();
    if (!query) throw new Error("Missing query text");

    const kbUrl = process.env.BLOB_BASE_URL
      ? `${process.env.BLOB_BASE_URL}/kb.json`
      : "https://nwavns9phcxcbmyj.public.blob.vercel-storage.com/kb.json";

    const kb = await fetch(kbUrl).then(r => r.json());
    if (!Array.isArray(kb)) throw new Error("Invalid KB format");

    const qEmb = await getEmbedding(query);

    const scored = kb
      .filter((item: any) => Array.isArray(item.embedding))
      .map((item: any) => ({
        question: item.question,
        answer: item.answer,
        score: cosineSim(qEmb, item.embedding)
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    return NextResponse.json({ query, results: scored });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

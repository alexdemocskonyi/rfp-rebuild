export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
const FALLBACK_BLOB_BASE =
  "https://9q4ay5sxapz9hmj4.public.blob.vercel-storage.com";
const KB_PATH = "kb.json";

async function getEmbeddingSafe(text: string): Promise<number[]> {
  try {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({ model: "text-embedding-3-small", input: text }),
    });
    const data = await res.json();
    if (!data.data || !data.data[0]) throw new Error("Failed to embed query");
    return data.data[0].embedding;
  } catch (err) {
    console.error("❌ EMBEDDING ERROR", err);
    return [];
  }
}

export async function POST(req: NextRequest) {
  try {
    const { query } = await req.json();
    if (!query) throw new Error("Missing query text");

    const emb = await getEmbeddingSafe(query);
    const kbUrl = `${process.env.BLOB_BASE_URL || FALLBACK_BLOB_BASE}/${KB_PATH}`;
    const kbRes = await fetch(kbUrl, { cache: "no-store" });
    if (!kbRes.ok) throw new Error("Failed to fetch KB");
    const kb = await kbRes.json();

    let best = { score: -1, match: null as any };
    for (const item of kb) {
      if (!item.embedding) continue;
      const dot = emb.reduce((s, v, i) => s + v * item.embedding[i], 0);
      if (dot > best.score) best = { score: dot, match: item };
    }

    return NextResponse.json({
      ok: true,
      bestMatch: best.match,
      score: best.score,
    });
  } catch (err: any) {
    console.error("❌ TEST_MATCH_ERROR", err);
    return NextResponse.json(
      { ok: false, error: err.message },
      { status: 500 }
    );
  }
}

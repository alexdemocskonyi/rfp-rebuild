import fs from "fs";
import path from "path";
import { getEmbedding } from "@/lib/embed";

const KB_PATH = path.join("/tmp", "kb.json");

function cosineSimilarity(a: number[], b: number[]) {
  const dot = a.reduce((sum, val, i) => sum + val * b[i], 0);
  const magA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
  const magB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
  return dot / (magA * magB || 1);
}

export async function retrieveMatches(embedding: number[], limit = 5) {
  try {
    let kbData: any[] = [];

    try {
      if (fs.existsSync(KB_PATH)) {
        const json = fs.readFileSync(KB_PATH, "utf8");
        kbData = JSON.parse(json);
      }
    } catch {
      kbData = [];
    }

    if (!kbData.length) {
      const res = await fetch("https://nwavns9phcxcbmyj.public.blob.vercel-storage.com/kb.json");
      kbData = await res.json();
    }

    const scored = kbData
      .filter((item: any) => item.embedding && item.embedding.length)
      .map((item: any) => ({
        ...item,
        score: cosineSimilarity(embedding, item.embedding),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    console.log(`[kb] returning ${scored.length} matches`);
    return scored;
  } catch (err: any) {
    console.error("KB_RETRIEVE_ERROR", err?.message || err);
    return [];
  }
}

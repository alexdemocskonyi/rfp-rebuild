function cosine(a: number[], b: number[]) {
  const dot = a.reduce((s, v, i) => s + v * b[i], 0);
  const magA = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
  const magB = Math.sqrt(b.reduce((s, v) => s + v * v, 0));
  return dot / (magA * magB || 1);
}

export async function retrieveMatches(queryEmbedding: number[], limit = 5) {
  try {
    const res = await fetch(process.env.KB_URL || "https://nwavns9phcxcbmyj.public.blob.vercel-storage.com/kb.json");
    const kb = await res.json();
    const scored = kb
      .filter((x: any) => Array.isArray(x.embedding) && x.embedding.length)
      .map((x: any) => ({ ...x, score: cosine(queryEmbedding, x.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    console.log(`[KB] top ${scored.length} matches:`);
    for (const m of scored) {
      console.log(`  - ${m.question.slice(0, 60)}... (${m.score.toFixed(3)}) [${m.source || "unknown"}]`);
    }

    return scored;
  } catch (err: any) {
    console.error("KB_RETRIEVE_ERROR", err.message);
    return [];
  }
}

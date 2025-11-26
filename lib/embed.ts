// lib/embed.ts
// Simple embedding helper using direct fetch instead of the OpenAI SDK.

function applyAliases(text: string): string {
  return (text || "").replace(/\blsws?\b/gi, "licensed social workers");
}

export async function getEmbedding(text: string): Promise<number[]> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    console.error("❌ EMBED_ERROR Missing OPENAI_API_KEY in environment");
    return [];
  }

  const raw = (text || "").trim();
  const clean = applyAliases(raw);
  if (!clean) return [];

  try {
    const body = {
      model: "text-embedding-3-small",
      input: clean.slice(0, 8000),
    };

    const resp = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        authorization: "Bearer " + key,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.error(
        "❌ EMBED_ERROR HTTP",
        resp.status,
        String(errText).slice(0, 300)
      );
      return [];
    }

    const data: any = await resp.json().catch((e: any) => {
      console.error("❌ EMBED_ERROR JSON parse", e?.message || e);
      return null;
    });

    if (!data || !Array.isArray(data.data) || !data.data[0]?.embedding) {
      console.error("❌ EMBED_ERROR Invalid embedding payload", data);
      return [];
    }

    const emb = data.data[0].embedding;
    return Array.isArray(emb) ? emb.map((n: any) => Number(n) || 0) : [];
  } catch (err: any) {
    console.error("❌ EMBED_ERROR", err?.message || err);
    return [];
  }
}

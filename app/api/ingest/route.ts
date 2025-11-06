import { NextRequest, NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { parseUnified } from "@/lib/unifiedParser";

export const runtime = "nodejs";
const KB_PATH = "kb.json";
const BATCH = 10;

async function getEmbeddingSafe(text: string, attempt = 1): Promise<number[]> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("Missing OPENAI_API_KEY");

  try {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ input: text, model: "text-embedding-3-small" }),
    });

    if (!res.ok) {
      const body = await res.text();
      if ([429, 500, 502, 524].includes(res.status) && attempt <= 3) {
        const wait = 1000 * attempt;
        console.warn(`⚠️ OpenAI error ${res.status}, retrying in ${wait}ms`);
        await new Promise((r) => setTimeout(r, wait));
        return getEmbeddingSafe(text, attempt + 1);
      }
      throw new Error(`OpenAI error ${res.status}: ${body}`);
    }

    const data = await res.json();
    return data.data?.[0]?.embedding ?? [];
  } catch (err: any) {
    if (attempt <= 3) {
      const wait = 1000 * attempt;
      console.warn(`⚠️ Network retry (${attempt}) after ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
      return getEmbeddingSafe(text, attempt + 1);
    }
    console.error("❌ EMBED FAIL:", err);
    return [];
  }
}

function normalizeQ(q: string) {
  return q.toLowerCase().replace(/\s+/g, " ").trim();
}

export async function POST(req: NextRequest) {
  console.log("🚀 [INGEST] route invoked");
  try {
    const form = await req.formData();
    const file = form.get("file") as File | null;
    if (!file) throw new Error("No file provided");

    const buf = Buffer.from(await file.arrayBuffer());
    console.log(`[INGEST] received file: ${file.name} (${buf.length} bytes)`);

    const parsed = await parseUnified(buf, file.name);
    console.log(`[INGEST] parsed ${parsed.length} questions`);

    if (parsed.length === 0)
      return NextResponse.json({ ok: false, reason: "No questions found" });

    let uploaded;
    try {
      uploaded = await put(`uploads/${file.name}`, buf, {
        access: "public",
        addRandomSuffix: true,
      });
      console.log("Blob uploaded:", uploaded.url);
    } catch (err: any) {
      throw new Error(`Blob upload failed: ${err.message}`);
    }

    const origin =
      process.env.BLOB_BASE_URL ||
      (uploaded.url.startsWith("http")
        ? new URL(uploaded.url).origin
        : "https://public.blob.vercel-storage.com");
    const kbUrl = `${origin}/${KB_PATH}`;

    let existing: any[] = [];
    try {
      const res = await fetch(kbUrl, { cache: "no-store" });
      if (res.ok) existing = await res.json();
    } catch {
      console.log("[INGEST] no existing KB found");
    }

    const seen = new Map<string, number[]>();
    for (const row of existing) seen.set(normalizeQ(row.question), row.embedding);
    const merged: any[] = [...existing];

    let processed = 0;
    for (let i = 0; i < parsed.length; i += BATCH) {
      const batch = parsed.slice(i, i + BATCH);
      const results = await Promise.all(
        batch.map(async (r) => {
          const key = normalizeQ(r.question);
          if (seen.has(key)) return { ...r, embedding: seen.get(key)! };
          const emb = await getEmbeddingSafe(r.question);
          return { ...r, embedding: emb };
        })
      );
      for (const r of results) {
        const k = normalizeQ(r.question);
        seen.set(k, r.embedding);
        const prev = merged.find((m) => normalizeQ(m.question) === k);
        if (!prev) merged.push(r);
      }
      processed += batch.length;
      console.log(`[INGEST] processed ${processed}/${parsed.length}`);
    }

    const saved = await put(KB_PATH, JSON.stringify(merged, null, 2), {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json",
    });

    console.log(`✅ [INGEST] KB updated: ${saved.url}`);
    return NextResponse.json({ ok: true, total: merged.length, kbUrl: saved.url });
  } catch (err: any) {
    console.error("❌ [INGEST_ERROR]", err);
    return NextResponse.json({ ok: false, error: err.message || "unknown failure" }, { status: 500 });
  }
}

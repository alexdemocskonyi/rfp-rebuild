import { NextRequest, NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { parseUnified } from "@/lib/unifiedParser";

export const runtime = "nodejs";
const KB_PATH = "kb.json";
const BATCH = 12;

function normalize(s: string) {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}
function keyFor(q: string, a: string, source: string) {
  return `${normalize(q)}|${normalize(a)}|${normalize(source)}`;
}
function isLikelyContext(text: string) {
  const t = text.trim();
  if (!t) return false;
  const words = t.split(/\s+/).length;
  const hasQuestionMark = /[?？]/.test(t);
  return words >= 20 && !hasQuestionMark;
}
function snippetOf(text: string, maxWords = 12) {
  const words = text.trim().split(/\s+/);
  const snip = words.slice(0, maxWords).join(" ");
  return words.length > maxWords ? `${snip}…` : snip;
}

async function getEmbeddingSafe(text: string): Promise<number[]> {
  const key = process.env.OPENAI_API_KEY;
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ input: text, model: "text-embedding-3-small" }),
  });
  const data = await res.json();
  return data.data?.[0]?.embedding ?? [];
}

export async function POST(req: NextRequest) {
  console.log("🚀 [INGEST] invoked");
  try {
    const form = await req.formData();
    const file = form.get("file") as File | null;
    if (!file) throw new Error("No file provided");

    const buf = Buffer.from(await file.arrayBuffer());
    const parsed = await parseUnified(buf, file.name);
    console.log(`[INGEST] parsed ${parsed.length} rows`);

    if (parsed.length === 0)
      return NextResponse.json({ ok: false, reason: "No questions found." });

    // Upload source file for reference
    const uploaded = await put(`uploads/${file.name}`, buf, {
      access: "public",
      addRandomSuffix: true,
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });
    const origin = process.env.BLOB_BASE_URL || new URL(uploaded.url).origin;
    const kbUrl = `${origin}/${KB_PATH}`;

    let existing: any[] = [];
    try {
      const res = await fetch(kbUrl, { cache: "no-store" });
      if (res.ok) existing = await res.json();
    } catch {}

    const seen = new Map<string, number>();
    for (const row of existing)
      seen.set(keyFor(row.question, row.answer, row.source || ""), 1);

    const newRows: any[] = [];
    let pairs = 0, contexts = 0, qOnly = 0;

    for (const r of parsed) {
      const q = r.question?.trim();
      const a = r.answer?.trim();
      const s = r.source || file.name.replace(/\.[^.]+$/, "");

      if (q && a) {
        const k = keyFor(q, a, s);
        if (!seen.has(k)) {
          newRows.push({ question: q, answer: a, source: s });
          pairs++;
        }
      } else if (!a && q) qOnly++;
      else if (!q && isLikelyContext(a)) contexts++;
    }

    console.log(`[INGEST] pairs=${pairs}, qOnly=${qOnly}, ctx=${contexts}`);

    if (newRows.length === 0) {
      console.warn("[INGEST] nothing new to embed; continuing for report use");
      return NextResponse.json({ ok: true, skipped: true, kbUrl, reason: "Q-only file" });
    }

    for (const r of newRows) {
      r.embedding = await getEmbeddingSafe(`${r.question}\n${r.answer}`);
      existing.push(r);
    }

    const saved = await put(KB_PATH, JSON.stringify(existing, null, 2), {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json",
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });

    console.log(`✅ [INGEST] KB updated: ${saved.url}`);

    return NextResponse.json({ ok: true, added: newRows.length, total: existing.length, kbUrl: saved.url });
  } catch (err: any) {
    console.error("❌ [INGEST_ERROR]", err);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}

// app/api/ingest-context/route.ts
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { parseUnified } from "@/lib/unifiedParser";
import { getEmbedding } from "@/lib/embed";
import { loadKb, saveKb, KBItem } from "@/lib/kb";

function norm(s: any) {
  return (s ?? "").toString().replace(/\s+/g, " ").trim();
}

export async function POST(req: NextRequest) {
  console.log("🚀 [INGEST-CONTEXT] route triggered");
  try {
    const form = await req.formData();
    const file = form.get("file") as File | null;
    if (!file) {
      return NextResponse.json(
        { ok: false, error: "No file provided" },
        { status: 400 }
      );
    }

    const buf = Buffer.from(await file.arrayBuffer());
    const filename = file.name || "context-upload";
    const baseSource = filename.replace(/\.[^.]+$/, "");

    console.log("📄 Processing context file:", filename);

    // Reuse unified parser to break the document into manageable text snippets.
    const parsed = await parseUnified(buf, filename);
    console.log(
      "📄 Parsed " + parsed.length + " rows from file (for context ingestion)"
    );

    if (!parsed.length) {
      return NextResponse.json(
        { ok: false, error: "No usable content found in file" },
        { status: 400 }
      );
    }

    const existing = (await loadKb()) || [];

    const contextItems: KBItem[] = [];

    for (const row of parsed) {
      const q = norm(row.question);
      const a = norm(row.answer);
      const srcCell = norm(row.source || "");
      const text = [q, a].filter(Boolean).join("\n").trim();

      if (!text || text.length < 40) {
        // skip very tiny fragments; they're usually noise
        continue;
      }

      const embedding = await getEmbedding(text);

      const item: KBItem = {
        kind: "context",
        content: text,
        source: srcCell || baseSource,
        origin: "context-upload",
        embedding,
      };

      contextItems.push(item);
    }

    if (!contextItems.length) {
      return NextResponse.json({
        ok: true,
        added: 0,
        total: existing.length,
        note: "Parsed content was too small or empty for context chunks.",
      });
    }

    const updated = [...existing, ...contextItems];

    await saveKb(updated);

    console.log(
      `✅ [INGEST-CONTEXT] Added ${contextItems.length} context chunks. New KB size: ${updated.length}`
    );

    return NextResponse.json({
      ok: true,
      added: contextItems.length,
      total: updated.length,
    });
  } catch (err: any) {
    console.error("❌ INGEST-CONTEXT ERROR", err);
    return NextResponse.json(
      { ok: false, error: err.message || "Unknown error" },
      { status: 500 }
    );
  }
}

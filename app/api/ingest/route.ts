// app/api/ingest/route.ts
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { parseUnified } from "@/lib/unifiedParser";
import { getEmbedding } from "@/lib/embed";

const BLOB_BASE_URL =
  "https://ynyzmdodop38gqsz.public.blob.vercel-storage.com";
const BLOB_TOKEN =
  "vercel_blob_rw_YnyZMdOdop38gqSz_5D6vQd4WlLmEGx76qZpzxpSfne7Ms4";
const KB_PATH = "kb.json";
const CHUNK_SIZE = 50;
const PARALLEL = 10;

function norm(s: any) {
  return (s ?? "").toString().replace(/\s+/g, " ").trim();
}
function normalize(s: string) {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}
function keyFor(q: string, a: string, src: string) {
  return `${normalize(q)}|${normalize(a)}|${normalize(src)}`;
}

export async function POST(req: NextRequest) {
  console.log("🚀 [INGEST] route triggered");
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
    const filename = file.name || "upload.bin";
    console.log(`📄 Processing file: ${filename}`);

    const parsed = await parseUnified(buf, filename);
    console.log(`📄 Parsed ${parsed.length} raw rows from file`);

    if (!parsed.length) {
      return NextResponse.json(
        { ok: false, error: "No Q/A entries found" },
        { status: 400 }
      );
    }

    // Always upload the raw source file so we have it
    const uploaded = await put(`uploads/${filename}`, buf, {
      access: "public",
      token: BLOB_TOKEN,
      addRandomSuffix: true,
    });
    console.log(`📤 Uploaded source: ${uploaded.url}`);

    // Only consider rows with a meaningful answer
    const answered = parsed.filter(
      (r) => norm(r.answer).length > 3 && norm(r.question).length > 0
    );
    const answeredCount = answered.length;

    console.log(
      `🧮 Answered rows: ${answeredCount}/${parsed.length} (>=4 chars answers)`
    );

    // Heuristic: if it's basically all questions & no answers, skip KB update
    const minThreshold = Math.max(5, Math.floor(parsed.length * 0.2)); // at least 5 & 20%
    if (answeredCount < minThreshold) {
      console.warn(
        `⚠️ [INGEST] File looks like QUESTION-ONLY (answers: ${answeredCount}/${parsed.length}) – skipping KB update`
      );
      return NextResponse.json({
        ok: true,
        skipped: true,
        total: 0,
        reason:
          "File appears to contain questions only (very few or no answers). Knowledge Base was not modified, but you can still generate a report using this file as the RFP source.",
      });
    }

    // Load existing KB
    const kbUrl = `${BLOB_BASE_URL}/${KB_PATH}?t=${Date.now()}`;
    let existing: any[] = [];
    try {
      const res = await fetch(kbUrl, { cache: "no-store" });
      if (res.ok) {
        existing = await res.json();
        console.log(`📚 Loaded existing KB with ${existing.length} entries`);
      } else {
        console.log("ℹ️ Existing KB fetch not OK, starting fresh");
      }
    } catch {
      console.log("ℹ️ No existing KB found or fetch failed, starting fresh");
    }
    if (!Array.isArray(existing)) existing = [];

    const seen = new Set(
      existing.map((e) =>
        keyFor(
          e.question || "",
          e.answer || "",
          e.source || "unknown-source"
        )
      )
    );

    // Only add NEW answered rows
    const newRows = answered.filter((r) => {
      const q = norm(r.question);
      const a = norm(r.answer);
      const src = r.source || filename;
      if (!q || !a) return false; // hard-stop on empty
      const k = keyFor(q, a, src);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    console.log(`🧩 Will embed ${newRows.length} new answered rows`);

    if (!newRows.length) {
      return NextResponse.json({
        ok: true,
        skipped: false,
        total: 0,
        reason: "All answered rows were already present in KB.",
      });
    }

    // Embed & append in chunks
    let added = 0;

    for (let i = 0; i < newRows.length; i += CHUNK_SIZE) {
      const chunk = newRows.slice(i, i + CHUNK_SIZE);

      for (let j = 0; j < chunk.length; j += PARALLEL) {
        const batch = chunk.slice(j, j + PARALLEL);

        const embeds = await Promise.all(
          batch.map((r) =>
            getEmbedding(`${norm(r.question)}\n${norm(r.answer)}`)
          )
        );

        for (let k = 0; k < batch.length; k++) {
          batch[k].question = norm(batch[k].question);
          batch[k].answer = norm(batch[k].answer);
          batch[k].source = batch[k].source || filename;
          batch[k].embedding = embeds[k];
        }
      }

      existing.push(...chunk);
      added += chunk.length;

      await put(KB_PATH, JSON.stringify(existing, null, 2), {
        access: "public",
        token: BLOB_TOKEN,
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: "application/json",
      });

      console.log(
        `💾 Saved partial KB batch. Current KB size: ${existing.length}`
      );
    }

    console.log(
      `✅ KB updated successfully – added ${added} answered entries. New total: ${existing.length}`
    );

    return NextResponse.json({
      ok: true,
      skipped: false,
      total: added, // NEW entries count
    });
  } catch (err: any) {
    console.error("❌ INGEST_ERROR", err);
    return NextResponse.json(
      { ok: false, error: err.message || "Unknown" },
      { status: 500 }
    );
  }
}

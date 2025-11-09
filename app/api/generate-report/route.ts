// app/api/generate-report/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { parseUnified } from "@/lib/unifiedParser";
import { getEmbedding } from "@/lib/embed";
import { retrieveMatches } from "@/lib/kb";

const MODEL = "gpt-4o-mini";
const BATCH_SIZE = 25;
const TOP_K = 10;
const MIN_SCORE = 0.32; // below this, treat as weak / noisy

function norm(s: string) {
  return (s || "").replace(/\s+/g, " ").trim();
}

// Normalize all legacy vendor names to "Uprise Health"
function normalizeVendorNames(text: string) {
  if (!text) return text;
  return text.replace(
    /\b(H.?C\s*HealthWorks|HMC\s*HealthWorks|HMC\b|IBH\b|Claremont\s+Behavioral\s+Health)\b/gi,
    "Uprise Health"
  );
}

function truncate(text: string, max = 400) {
  const t = norm(text);
  if (t.length <= max) return t;
  return t.slice(0, max - 1) + "…";
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

export async function POST(req: NextRequest) {
  console.log("🚀 [REPORT] route active (batched JSON)");

  try {
    const form = await req.formData();
    const file = form.get("file") as File | null;
    const batchIndex = Number(form.get("batch") || 0) || 0;

    if (!file) {
      return NextResponse.json(
        { ok: false, error: "No file provided" },
        { status: 400 }
      );
    }

    const buf = Buffer.from(await file.arrayBuffer());
    const filename = file.name;
    const parsed = await parseUnified(buf, filename);

    if (!parsed.length) {
      return NextResponse.json(
        { ok: false, error: "No valid questions found in file" },
        { status: 400 }
      );
    }

    const totalQuestions = parsed.length;
    console.log(
      `[REPORT] Parsed ${totalQuestions} questions (full file), batchIndex=${batchIndex}`
    );

    const start = batchIndex * BATCH_SIZE;
    if (start >= totalQuestions) {
      // nothing left
      return NextResponse.json({
        ok: true,
        batchIndex,
        totalQuestions,
        done: true,
        items: [],
      });
    }

    const end = Math.min(start + BATCH_SIZE, totalQuestions);
    const questions = parsed.slice(start, end);

    console.log(
      `[REPORT] Processing batch ${batchIndex} (Q${start + 1}–Q${end} of ${totalQuestions})`
    );

    const OPENAI_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_KEY) {
      throw new Error("Missing OPENAI_API_KEY environment variable");
    }

    const items: {
      question: string;
      aiAnswer: string;
      sourcesUsed: string[];
      contextualMatches: { source: string; snippet: string }[];
      rawTextMatches: { source: string; snippet: string }[];
    }[] = [];

    for (const [i, row] of questions.entries()) {
      const globalIndex = start + i;
      const qRaw = norm(row.question);
      if (!qRaw) continue;

      console.log(`[REPORT] Q${globalIndex + 1}: ${qRaw.slice(0, 120)}…`);

      const emb = await getEmbedding(qRaw);

      // 🔹 hybrid retrieval (semantic + lexical)
      const matches: any[] = await retrieveMatches(emb, TOP_K, qRaw as any);

      // keep only strong matches with non-empty answers
      const strongMatches = (matches || []).filter(
        (m) =>
          typeof m.score === "number" &&
          m.score >= MIN_SCORE &&
          m.answer &&
          norm(m.answer).length > 0
      );

      // de-dupe by normalized answer text so the same KB answer doesn't appear multiple times
      const seenAnswers = new Set<string>();
      const dedupedStrong: any[] = [];
      for (const m of strongMatches) {
        const key = norm(m.answer).toLowerCase();
        if (seenAnswers.has(key)) continue;
        seenAnswers.add(key);
        dedupedStrong.push(m);
      }

      // candidates sent to the model
      const candidates = dedupedStrong.map((m, idx) => ({
        idx: idx + 1,
        answer: normalizeVendorNames(norm(m.answer || "")),
      }));

      const candidatesBlock =
        candidates.length > 0
          ? candidates
              .map((c) => `[Answer ${c.idx}]\n${c.answer}`)
              .join("\n\n")
          : "(none)";

      const prompt = [
        "You are an expert RFP analyst for Uprise Health.",
        "",
        "You will be given:",
        "- a client RFP question, and",
        "- up to 10 candidate answers from our internal knowledge base.",
        "",
        "Your job:",
        "1. Use ONLY facts that appear in the candidate answers.",
        "2. Synthesize them into a single, clear, concise, client-ready answer.",
        "3. If answers conflict, prefer the one that is most specific and detailed.",
        "4. Normalize all legacy names (e.g., 'HMC HealthWorks', 'H C HealthWorks', 'HMC', 'IBH', 'Claremont Behavioral Health') to 'Uprise Health' in the final answer.",
        "5. Do NOT mention answer numbers, scores, or internal sources.",
        "6. If NONE of the candidates actually address the question, reply exactly:",
        "   Information not found in KB.",
        "",
        `Question:\n${qRaw}`,
        "",
        `Candidate answers:\n${candidatesBlock}`,
      ].join("\n");

      const completion = await fetch(
        "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${OPENAI_KEY}`,
          },
          body: JSON.stringify({
            model: MODEL,
            messages: [{ role: "user", content: prompt }],
            temperature: 0.25,
          }),
        }
      );

      let aiAnswer = "Information not found in KB.";
      try {
        const data = await completion.json();
        const raw =
          data.choices?.[0]?.message?.content?.trim() ||
          "Information not found in KB.";
        aiAnswer = normalizeVendorNames(raw);
      } catch (err) {
        console.error("⚠️ GPT parse error", err);
      }

      // ✅ SOURCES USED (unique KB source names)
      const sourcesUsed = uniqueStrings(
        dedupedStrong
          .map((m) =>
            norm(
              m.source ||
                m.sourceFile ||
                m.doc ||
                m.origin ||
                "Unknown source"
            )
          )
          .filter(Boolean)
      );

      // ✅ TOP CONTEXTUAL MATCHES (semantic) – use full KB answers as snippets
      const contextualMatches: { source: string; snippet: string }[] = [];
      for (const m of dedupedStrong) {
        const source = norm(
          m.source || m.sourceFile || m.doc || m.origin || "Unknown source"
        );
        const snippet = truncate(
          normalizeVendorNames(m.answer || m.question || "")
        );
        if (!snippet) continue;

        const key = `${source}|${snippet}`.toLowerCase();
        if (
          contextualMatches.some(
            (c) =>
              c.source.toLowerCase() === source.toLowerCase() &&
              c.snippet.toLowerCase() === snippet.toLowerCase()
          )
        ) {
          continue;
        }

        contextualMatches.push({ source, snippet });
        if (contextualMatches.length >= 3) break;
      }

      // ✅ TOP RAW-TEXT MATCHES (lexical) – based on lexicalScore, no duplicates with contextual
      const rawTextMatches: { source: string; snippet: string }[] = [];
      const byLexical = [...dedupedStrong].sort(
        (a, b) => (b.lexicalScore || 0) - (a.lexicalScore || 0)
      );

      for (const m of byLexical) {
        const source = norm(
          m.source || m.sourceFile || m.doc || m.origin || "Unknown source"
        );
        const snippet = truncate(
          normalizeVendorNames(m.answer || m.question || "")
        );
        if (!snippet) continue;

        const lowerSnippet = snippet.toLowerCase();

        // skip if already used as contextual
        if (
          contextualMatches.some(
            (c) => c.snippet.toLowerCase() === lowerSnippet
          )
        ) {
          continue;
        }

        // skip if already in raw
        if (
          rawTextMatches.some(
            (c) => c.snippet.toLowerCase() === lowerSnippet
          )
        ) {
          continue;
        }

        rawTextMatches.push({ source, snippet });
        if (rawTextMatches.length >= 3) break;
      }

      items.push({
        question: qRaw,
        aiAnswer,
        sourcesUsed,
        contextualMatches,
        rawTextMatches,
      });
    }

    const done = end >= totalQuestions;

    return NextResponse.json({
      ok: true,
      batchIndex,
      totalQuestions,
      done,
      items,
    });
  } catch (err: any) {
    console.error("❌ GEN_REPORT_ERROR", err);
    return NextResponse.json(
      { ok: false, error: err.message || "Unknown error" },
      { status: 500 }
    );
  }
}

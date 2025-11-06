// app/api/generate-report/route.ts
import { NextResponse } from "next/server";
import { getEmbedding } from "@/lib/embed";
import { retrieveMatches } from "@/lib/kb";
import { parseUnified } from "@/lib/unifiedParser";
import { Document, Packer, Paragraph, HeadingLevel, TextRun } from "docx";
import OpenAI from "openai";
import stringSimilarity from "string-similarity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

/** Utility helpers **/
function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withTimeout<T>(p: Promise<T>, ms: number, label = "op"): Promise<T> {
  let timeoutId: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
  });
  try {
    const res = await Promise.race([p, timeout]);
    clearTimeout(timeoutId!);
    return res;
  } catch (e) {
    clearTimeout(timeoutId!);
    throw e;
  }
}

/** Generic retry wrapper **/
async function safeCall<T>(
  fn: () => Promise<T>,
  label: string,
  retries = 3,
  delayMs = 2000
): Promise<T | null> {
  for (let i = 0; i < retries; i++) {
    try {
      return await withTimeout(fn(), 60000, label); // ⬅️ Increased to 60s
    } catch (e: any) {
      console.warn(`⚠️ ${label} attempt ${i + 1} failed: ${e.message}`);
      await delay(delayMs * (i + 1));
    }
  }
  console.error(`❌ ${label} failed after ${retries} retries`);
  return null;
}

/** Helper to safely fetch remote JSON (like KB) **/
async function fetchJSONWithTimeout(url: string, ms: number) {
  const res = await withTimeout(fetch(url, { cache: "no-store" }), ms, `fetch ${url}`);
  if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
  return res.json();
}

/** Fuzzy text matching **/
function bestFuzzyMatch(q: string, kb: any[]) {
  if (!kb?.length) return { match: null, score: 0 };
  const list = kb.map((x) => x.question || "");
  const { bestMatchIndex, bestMatch } = stringSimilarity.findBestMatch(q, list);
  return { match: kb[bestMatchIndex], score: bestMatch.rating };
}

/** OpenAI helper for synthesis **/
async function generateAnswer(prompt: string, system: string, attempt = 1): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("Missing OPENAI_API_KEY");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000); // 60s timeout

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini", // ⬅️ small, fast, cost-efficient
        temperature: 0.3,
        max_tokens: 800,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);
    if (!res.ok) throw new Error(`OpenAI error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() ?? "";
  } catch (err: any) {
    clearTimeout(timeout);
    if (attempt < 3) {
      console.warn(`⚠️ synthesis retry ${attempt}: ${err.message}`);
      await delay(2000 * attempt);
      return generateAnswer(prompt, system, attempt + 1);
    }
    console.error("❌ synthesis failed", err);
    return "(no answer generated)";
  }
}

/** Main POST handler **/
export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    if (!file) throw new Error("No file uploaded");

    const filename = (file as any).name || "upload.bin";
    const buf = Buffer.from(await file.arrayBuffer());
    console.log("[REPORT] uploaded", filename, buf.length, "bytes");

    const parsed = await parseUnified(buf, filename);
    if (!parsed.length) throw new Error("No valid questions found in file.");
    console.log(`[REPORT] parsed ${parsed.length} questions`);

    // Fetch Knowledge Base (KB)
    const kbData = await fetchJSONWithTimeout(
      "https://public.blob.vercel-storage.com/kb.json",
      20000
    );

    const paras: Paragraph[] = [
      new Paragraph({ text: "UPRISE RFP REPORT", heading: HeadingLevel.HEADING_1 }),
      new Paragraph({ text: `Questions analyzed: ${parsed.length}` }),
      new Paragraph({ text: " " }),
    ];

    let index = 0;
    for (const row of parsed) {
      const q = row.question?.trim();
      if (!q) continue;
      index++;
      console.log(`[q${index}] start: ${q.slice(0, 80)}...`);

      const emb = await safeCall(() => getEmbedding(q), `embedding q${index}`);
      const semMatches = emb
        ? await safeCall(() => retrieveMatches(emb, 5), `retrieveMatches q${index}`)
        : [];

      const fuzzy = bestFuzzyMatch(q, kbData);
      const context = Array.isArray(semMatches)
        ? semMatches.map((m: any) => m.answer).join("\n\n")
        : "";

      // Contextual refinement
      const contextualAns = await safeCall(
        () =>
          generateAnswer(
            `Question: ${q}\n\nContext:\n${context}`,
            "You are an expert RFP analyst. Refine and contextualize matched answers."
          ),
        `contextual q${index}`
      );

      // AI synthesis for final answer
      const aiAnswer = await safeCall(
        () =>
          generateAnswer(
            `Question: ${q}\n\nContext:\n${context}\n\nFuzzy:\n${fuzzy.match?.answer || ""}`,
            "You are an RFP automation assistant. Produce a strong, compliant, well-written RFP response using all available context."
          ),
        `synthesis q${index}`
      );

      console.log(`[q${index}] done`);

      paras.push(
        new Paragraph({
          children: [new TextRun({ text: `Question ${index}: ${q}`, bold: true, size: 32 })],
        }),
        new Paragraph({ text: "Contextual Answer — Semantic", heading: HeadingLevel.HEADING_3 }),
        new Paragraph({ text: semMatches?.[0]?.answer || "N/A" }),
        new Paragraph({ text: "Contextual Answer — AI Refined", heading: HeadingLevel.HEADING_3 }),
        new Paragraph({ text: contextualAns || "N/A" }),
        new Paragraph({ text: "Fuzzy Match", heading: HeadingLevel.HEADING_3 }),
        new Paragraph({ text: fuzzy?.match?.answer || "N/A" }),
        new Paragraph({ text: "AI-Derived Final Answer", heading: HeadingLevel.HEADING_3 }),
        new Paragraph({ text: aiAnswer || "N/A" }),
        new Paragraph({ text: " " })
      );
    }

    const bufferOut = await withTimeout(
      Packer.toBuffer(new Document({ sections: [{ children: paras }] })),
      30000,
      "docx pack"
    );

    return new Response(new Uint8Array(bufferOut), {
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="Structured_RFP_Report_${Date.now()}.docx"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err: any) {
    console.error("GEN_REPORT_ERROR", err);
    return NextResponse.json(
      { ok: false, error: err.message || "Report generation failed" },
      { status: 500 }
    );
  }
}

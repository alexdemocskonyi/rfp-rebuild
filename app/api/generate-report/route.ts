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

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  label = "op"
): Promise<T> {
  let timeoutId: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`${label} timeout after ${ms}ms`)),
      ms
    );
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

async function safeCall<T>(
  fn: () => Promise<T>,
  label: string,
  retries = 2,
  delayMs = 2000
): Promise<T | null> {
  for (let i = 0; i <= retries; i++) {
    try {
      return await withTimeout(fn(), 20000, label);
    } catch (e: any) {
      console.warn(`⚠️ ${label} attempt ${i + 1} failed: ${e.message}`);
      if (i < retries) await delay(delayMs * (i + 1));
    }
  }
  console.error(`❌ ${label} failed after ${retries + 1} tries`);
  return null;
}

async function fetchJSONWithTimeout(url: string, ms: number) {
  const res = await withTimeout(fetch(url, { cache: "no-store" }), ms, `fetch ${url}`);
  if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
  return res.json();
}

function bestFuzzyMatch(q: string, kb: any[]) {
  const list = kb.map((x) => x.question || "");
  const { bestMatchIndex, bestMatch } = stringSimilarity.findBestMatch(q, list);
  return { match: kb[bestMatchIndex], score: bestMatch.rating };
}

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

    const kbData = await fetchJSONWithTimeout(
      "https://nwavns9phcxcbmyj.public.blob.vercel-storage.com/kb.json",
      20000
    );

    const paras: Paragraph[] = [
      new Paragraph({ text: "UPRISE RFP REPORT", heading: HeadingLevel.HEADING_1 }),
      new Paragraph({ text: `Questions considered: ${parsed.length}` }),
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

      const contextualAns = await safeCall(async () => {
        const res = await openai.chat.completions.create({
          model: "gpt-4-turbo",
          temperature: 0.3,
          max_tokens: 600,
          messages: [
            { role: "system", content: "Refine and contextualize matched answers." },
            { role: "user", content: `Question: ${q}\n\nContext:\n${context}` },
          ],
        });
        return res.choices[0].message.content?.trim() || "";
      }, `contextual q${index}`);

      const aiAnswer = await safeCall(async () => {
        const res = await openai.chat.completions.create({
          model: "gpt-4-turbo",
          temperature: 0.3,
          max_tokens: 800,
          messages: [
            { role: "system", content: "Produce the best possible RFP answer using all context." },
            { role: "user", content: `Question: ${q}\n\nContext:\n${context}\n\nFuzzy:\n${fuzzy.match?.answer}` },
          ],
        });
        return res.choices[0].message.content?.trim() || "";
      }, `synthesis q${index}`);

      console.log(`[q${index}] done`);

      paras.push(
        new Paragraph({
          children: [new TextRun({ text: `Question ${index}: ${q}`, bold: true, size: 32 })],
        }),
        new Paragraph({ text: "Contextual Answer — Semantic", heading: HeadingLevel.HEADING_3 }),
        new Paragraph({ text: semMatches?.[0]?.answer || "N/A" }),
        new Paragraph({ text: "Contextual Answer — AI Matched", heading: HeadingLevel.HEADING_3 }),
        new Paragraph({ text: contextualAns || "N/A" }),
        new Paragraph({ text: "Direct / Fuzzy / Raw Match", heading: HeadingLevel.HEADING_3 }),
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

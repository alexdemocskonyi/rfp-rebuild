import { NextResponse } from "next/server";
import { getEmbedding } from "@/lib/embed";
import { retrieveMatches } from "@/lib/kb";
import { parseUnified } from "@/lib/unifiedParser";
import { Document, Packer, Paragraph, HeadingLevel, TextRun } from "docx";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import stringSimilarity from "string-similarity";

process.env.BLOB_BASE_URL = "https://nwavns9phcxcbmyj.public.blob.vercel-storage.com";
process.env.KB_URL = `${process.env.BLOB_BASE_URL}/kb.json`;
console.log("[REPORT] KB_URL =", process.env.KB_URL);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get("file") as File;
    if (!file) throw new Error("No file uploaded");

    const buf = Buffer.from(await file.arrayBuffer());
    console.log("[REPORT] uploaded", file.name, buf.length, "bytes");

    const parsed = await parseUnified(buf, file.name);
    console.log(`[REPORT] parsed ${parsed.length} questions`);

    let kbUrl = process.env.KB_URL!;
    try {
      const metaPath = path.resolve(".vercel/blob-latest.json");
      if (fs.existsSync(metaPath)) {
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        kbUrl = meta.kbUrl || kbUrl;
        console.log(`[REPORT] Using KB from ${metaPath}: ${kbUrl}`);
      }
    } catch {}

    console.log(`[REPORT] Loading KB from ${kbUrl}`);
    const res = await fetch(kbUrl);
    const rawData = await res.json();
    console.log(`[REPORT] Loaded ${rawData.length} KB entries`);

    const kbData = rawData.map((x: any) => ({
      question: x.question || "",
      answer: x.answer || "",
      embedding: x.embedding || [],
      source: x.source || "unknown",
    }));

    const paras: Paragraph[] = [
      new Paragraph({ text: "UPRISE RFP REPORT", heading: HeadingLevel.HEADING_1 }),
      new Paragraph({ text: `Questions processed: ${parsed.length}` }),
      new Paragraph({ text: " " }),
    ];

    let i = 0;
    for (const row of parsed) {
      i++;
      const q = row.question?.trim();
      if (!q) continue;

      const emb = await getEmbedding(`${q} ${row.answer || ""}`);
      const sem = await retrieveMatches(emb, 5);

      const fuzzy = stringSimilarity.findBestMatch(
        q,
        kbData.map((x: any) => x.question || "")
      );
      const bestFuzzy = kbData[fuzzy.bestMatchIndex];
      const sources = [
        ...new Set([
          ...sem.map((m: any) => m.source),
          bestFuzzy?.source,
        ].filter(Boolean)),
      ];

      const context = [
        ...sem.map((m) => m.answer || "—"),
        bestFuzzy?.answer || "",
      ].join("\n\n");

      const aiAnswerRes = await openai.chat.completions.create({
        model: "gpt-4-turbo",
        temperature: 0.3,
        max_tokens: 800,
        messages: [
          { role: "system", content: "You are an RFP assistant; produce the best possible answer using all context." },
          { role: "user", content: `Question: ${q}\n\nContext:\n${context}` },
        ],
      });
      const aiAnswer = aiAnswerRes.choices[0].message.content?.trim() || "N/A";

      paras.push(
        new Paragraph({ children: [new TextRun({ text: `Question ${i}: ${q}`, bold: true, size: 28 })] }),
        new Paragraph({ text: "Top Semantic Matches", heading: HeadingLevel.HEADING_3 }),
        new Paragraph({ text: sem.map((m) => `${m.answer}\n(Source: ${m.source})`).join("\n\n") || "N/A" }),
        new Paragraph({ text: "Fuzzy Match", heading: HeadingLevel.HEADING_3 }),
        new Paragraph({ text: `${bestFuzzy?.answer || "N/A"}\n(Source: ${bestFuzzy?.source || "unknown"})` }),
        new Paragraph({ text: "AI-Derived Final Answer", heading: HeadingLevel.HEADING_3 }),
        new Paragraph({ text: aiAnswer }),
        new Paragraph({ text: `Sources: ${sources.join(", ")}` }),
        new Paragraph({ text: " " })
      );
    }

    const buffer = await Packer.toBuffer(new Document({ sections: [{ children: paras }] }));
    return new Response(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="RFP_Report_${Date.now()}.docx"`,
      },
    });
  } catch (err: any) {
    console.error("GEN_REPORT_ERROR", err);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}

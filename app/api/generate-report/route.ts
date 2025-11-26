// app/api/generate-report/route.ts
/**
 * app/api/generate-report/route.ts
 * - No name redaction in outputs
 * - XLSX replica = original workbook with AI answers written into answer column
 * - DOCX replica (Option B) = original .docx edited in place by patching document.xml
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import JSZip from "jszip";
import * as XLSX from "xlsx";

import { parseUnified } from "@/lib/unifiedParser";
import { getEmbedding } from "@/lib/embed";
import { retrieveMatchesWithContext } from "@/lib/kb";

import { buildAnalystDocx } from "@/lib/buildAnalystDocx";
import { buildSimpleDocx } from "@/lib/buildSimpleDocx";
import { buildReplicaDocx } from "@/lib/fillReplicaDocx";
import { buildXlsxReport } from "@/lib/buildXlsxReport";

/* -----------------------------------
   DOCX sanitizer (reports only)
   No redaction, just control character cleanup
------------------------------------ */

export function sanitizeForDocx(input: any): string {
  const raw = input == null ? "" : String(input);
  // remove C0 control characters
  return raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim();
}

/* ---------------------------------- Helpers --------------------------------- */

const MODEL = "gpt-4o-mini";
const TOP_K = 10;
const MIN_SCORE = 0.32;

const Q_HEADER_REGEX = /(question|prompt|rfp\s*item|inquiry|ask)/i;
const A_HEADER_REGEX =
  /(answer|response|reply|details|description|explanation|ai\s*answer)/i;

function norm(value: any): string {
  if (value == null) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

function normalizeVendorNames(text: string): string {
  if (text.length === 0) return text;
  return text.replace(
    /\b(H.?C\s*HealthWorks|HMC\s*HealthWorks|HMC\b|IBH\b|Claremont\s+Behavioral\s+Health)\b/gi,
    "Uprise Health"
  );
}

function needsNumeric(question: string): boolean {
  const t = question.toLowerCase();
  return /# of|number of|how many|count|percentage|%|rate|current\s+app\s+store/.test(
    t
  );
}

/**
 * Normalize question strings into a stable key so we can match
 * workbook / docx content to parsed items by text, not row index.
 */
function makeQuestionKey(source: string): string {
  let t = norm(source).toLowerCase();
  if (t.length === 0) return "";

  // normalize curly quotes
  t = t.replace(/[\u2018\u2019]/g, "'");
  t = t.replace(/[\u201C\u201D]/g, '"');

  // drop trailing punctuation
  t = t.replace(/[?.,;:]+$/g, "");

  // drop quotes
  t = t.replace(/["'`]/g, "");

  return t.trim();
}

function safeSnippet(text: string): string {
  try {
    return normalizeVendorNames(norm(text));
  } catch {
    return "";
  }
}

/* --------------------------------------------------------------------------- */

type MatchItem = { source: string; snippet: string };

export type QAItem = {
  question: string;
  aiAnswer: string;
  sourcesUsed: string[];
  contextualMatches: MatchItem[];
  rawTextMatches: MatchItem[];
  // NEW: raw context chunks (contracts, SOWs, policies, etc.)
  contextChunks?: MatchItem[];
};

/* ---------------------------------------------------------------------------
   XLSX replica helper
--------------------------------------------------------------------------- */

/**
 * Find the header row for a sheet by scanning the first few rows
 * for something that looks like a question or answer column header.
 */
function findHeaderRow(ws: XLSX.WorkSheet, range: XLSX.Range): number {
  const maxScanRow = Math.min(range.e.r, range.s.r + 15);
  for (let r = range.s.r; r <= maxScanRow; r++) {
    let hasHeader = false;
    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = (ws as any)[addr];
      const header = norm(cell && (cell.v ?? cell.w));
      if (header.length === 0) continue;
      if (Q_HEADER_REGEX.test(header) || A_HEADER_REGEX.test(header)) {
        hasHeader = true;
        break;
      }
    }
    if (hasHeader) return r;
  }
  // fallback: top row
  return range.s.r;
}

/**
 * For XLSX:
 * - open the original workbook
 * - identify question and answer columns by headers (or best guess)
 * - for each row whose question text matches a parsed QAItem.question,
 *   drop the AI answer into the answer column
 * - if there is no clear answer column, create a new "AI Answer" column
 *   at the far right and write into that
 */
function buildReplicaWorkbookFromOriginalXlsx(
  items: QAItem[],
  originalBuffer: Buffer
): Buffer {
  const wb = XLSX.read(originalBuffer, { type: "buffer" });

  const qaMap = new Map<string, string>();
  for (const item of items) {
    const key = makeQuestionKey(item.question);
    if (key.length === 0) continue;
    if (qaMap.has(key) === false) {
      const answer =
        item.aiAnswer && item.aiAnswer.trim().length > 0
          ? item.aiAnswer
          : "Information not found in KB.";
      qaMap.set(key, answer);
    }
  }

  const refKey = String.fromCharCode(33) + "ref";

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    if (ws === undefined || ws === null) continue;

    const refValue = (ws as any)[refKey];
    if (refValue === undefined || refValue === null) continue;

    const range = XLSX.utils.decode_range(refValue);
    if (range.s.r > range.e.r || range.s.c > range.e.c) continue;

    const headerRow = findHeaderRow(ws, range);

    let qCol: number = range.s.c;
    let aCol: number | null = null;

    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r: headerRow, c });
      const cell = (ws as any)[addr];
      const header = norm(cell && (cell.v ?? cell.w));
      if (header.length === 0) continue;

      if (Q_HEADER_REGEX.test(header)) qCol = c;
      if (aCol === null && A_HEADER_REGEX.test(header)) aCol = c;
    }

    if (aCol === null) {
      aCol = range.e.c + 1;
      const headerAddr = XLSX.utils.encode_cell({ r: headerRow, c: aCol });
      (ws as any)[headerAddr] = {
        t: "s",
        v: "AI Answer",
      };
      range.e.c = aCol;
      (ws as any)[refKey] = XLSX.utils.encode_range(range);
    }

    const answerCol = aCol as number;

    for (let r = headerRow + 1; r <= range.e.r; r++) {
      const qAddr = XLSX.utils.encode_cell({ r, c: qCol });
      const qCell = (ws as any)[qAddr];
      const questionText = norm(qCell && (qCell.v ?? qCell.w));
      if (questionText.length === 0) continue;

      const key = makeQuestionKey(questionText);
      if (key.length === 0) continue;

      const aiAnswer = qaMap.get(key);
      if (
        aiAnswer === undefined ||
        aiAnswer === null ||
        aiAnswer.trim().length === 0
      ) {
        continue;
      }

      const aAddr = XLSX.utils.encode_cell({ r, c: answerCol });
      const existing = (ws as any)[aAddr] || {};

      (ws as any)[aAddr] = {
        ...existing,
        t: "s",
        v: aiAnswer,
      };
    }
  }

  const out = XLSX.write(wb, { bookType: "xlsx", type: "buffer" }) as Buffer;
  return Buffer.from(out);
}

/* ---------------------------------------------------------------------------
   DOCX replica helper (Option B)
--------------------------------------------------------------------------- */

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function buildReplicaDocxFromOriginalDocx(
  items: QAItem[],
  originalBuffer: Buffer
): Promise<Buffer> {
  try {
    const zip = await JSZip.loadAsync(originalBuffer);
    const docFile = zip.file("word/document.xml");
    if (docFile == null) {
      // Fallback to the old docx builder if document.xml is missing
      return await buildReplicaDocx(items, "Replica_Answers.docx");
    }

    let xml = await docFile.async("string");

    // Build map from normalized question key to sanitized answer
    const qaMap = new Map<string, string>();
    for (const item of items) {
      const key = makeQuestionKey(item.question);
      if (key.length === 0) continue;
      if (qaMap.has(key)) continue;
      const baseAnswer =
        item.aiAnswer && item.aiAnswer.trim().length > 0
          ? item.aiAnswer
          : "Information not found in KB.";
      qaMap.set(key, sanitizeForDocx(baseAnswer));
    }

    const questionList = items.map((it) => it.question);

    function findOriginalQuestionText(key: string): string {
      for (const q of questionList) {
        if (makeQuestionKey(q) === key) return q;
      }
      return "";
    }

    for (const [qKey, answer] of qaMap.entries()) {
      const originalQuestion = findOriginalQuestionText(qKey);
      if (originalQuestion.length === 0) continue;

      const needleText = norm(originalQuestion);
      if (needleText.length === 0) continue;

      const needle = "<w:t>" + escapeXml(needleText) + "</w:t>";
      const startIndex = xml.indexOf(needle);
      if (startIndex < 0) {
        // Question text may be split across multiple runs; skip gracefully
        continue;
      }

      const paragraphStart = xml.lastIndexOf("<w:p", startIndex);
      const paragraphEnd = xml.indexOf("</w:p>", startIndex);
      if (paragraphStart < 0 || paragraphEnd < 0) continue;

      const paraXml = xml.slice(
        paragraphStart,
        paragraphEnd + "</w:p>".length
      );

      let pPrXml = "";
      const pPrStart = paraXml.indexOf("<w:pPr");
      if (pPrStart >= 0) {
        const pPrEnd = paraXml.indexOf("</w:pPr>", pPrStart);
        if (pPrEnd >= 0) {
          pPrXml = paraXml.slice(pPrStart, pPrEnd + "</w:pPr>".length);
        }
      }

      const insertPos = paragraphEnd + "</w:p>".length;

      const answerParagraph =
        "<w:p>" +
        pPrXml +
        "<w:r>" +
        "<w:t>" +
        escapeXml(answer) +
        "</w:t>" +
        "</w:r>" +
        "</w:p>";

      xml = xml.slice(0, insertPos) + answerParagraph + xml.slice(insertPos);
    }

    zip.file("word/document.xml", xml);
    const updated = await zip.generateAsync({ type: "nodebuffer" });
    return Buffer.from(updated);
  } catch (err) {
    console.error("DOCX replica error", err);
    return await buildReplicaDocx(items, "Replica_Answers.docx");
  }
}

/* ---------------------------------------------------------------------------
   Main report generation route
--------------------------------------------------------------------------- */

export async function POST(req: NextRequest) {
  console.log("[REPORT] ZIP-enabled route active");

  try {
    const form = await req.formData();
    const file = form.get("file") as File | null;

    if (file === null) {
      return NextResponse.json({ ok: false, error: "No file provided" });
    }

    const filename = file.name || "RFP_input";
    const base = filename.replace(/\.[^.]+$/, "");
    const lower = filename.toLowerCase();
    const buf = Buffer.from(await file.arrayBuffer());

    console.log("Parsing document:", filename);
    const parsed = await parseUnified(buf, filename);

    if (parsed.length === 0) {
      return NextResponse.json({
        ok: false,
        error: "No valid questions found in file",
      });
    }

    const OPENAI_KEY = process.env.OPENAI_API_KEY;
    if (typeof OPENAI_KEY === "string" && OPENAI_KEY.length > 0) {
      // ok
    } else {
      throw new Error("Missing OPENAI_API_KEY");
    }

    const items: QAItem[] = [];

    for (let i = 0; i < parsed.length; i++) {
      const qRaw = norm(parsed[i].question);
      if (qRaw.length === 0) continue;

      const emb = await getEmbedding(qRaw);

      // NEW: retrieve QA matches + context chunks
      const { qaMatches, contextMatches } = await retrieveMatchesWithContext(
        emb,
        TOP_K,
        5,
        qRaw
      );

      const matches = qaMatches || [];

      // strict first, then fallback like chat route
      let good = matches.filter(
        (m: any) => (m.score ?? 0) >= MIN_SCORE && m.answer
      );

      if (good.length === 0 && matches && matches.length > 0) {
        console.log(
          "[REPORT] No matches >= MIN_SCORE; falling back to top matches for question:",
          qRaw
        );
        good = matches.filter((m: any) => m.answer);
      }

      const seen = new Set<string>();
      const deduped: any[] = [];

      for (const m of good) {
        const answerText = norm(m.answer);
        const key = answerText.toLowerCase();
        if (key.length === 0) continue;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(m);
      }

      // Build candidate block: QA answers + context excerpts
      let qaBlock = "(none)";
      if (deduped.length > 0) {
        qaBlock = deduped
          .map(
            (m, idx) =>
              "[KB Answer " +
              String(idx + 1) +
              "] (source: " +
              norm(m.source || m.origin || "Unknown source") +
              ")\n" +
              normalizeVendorNames(norm(m.answer))
          )
          .join("\n\n");
      }

      let contextBlock = "";
      const ctxSlices = (contextMatches || []).slice(0, 5);
      if (ctxSlices.length > 0) {
        contextBlock =
          "Relevant contract/context excerpts:\n\n" +
          ctxSlices
            .map(
              (c, idx) =>
                "[Context " +
                String(idx + 1) +
                "] (source: " +
                norm(c.source || c.origin || "Unknown source") +
                ")\n" +
                safeSnippet(c.content || c.answer || c.question || "")
            )
            .join("\n\n");
      }

      const pieces: string[] = [];
      pieces.push("KB Q/A answers:\n\n" + qaBlock);
      if (contextBlock) {
        pieces.push(contextBlock);
      }

      const candidateBlock =
        pieces.length > 0 ? pieces.join("\n\n--------------------\n\n") : "(none)";

      const prompt = [
        "You are an expert RFP analyst for Uprise Health.",
        "",
        "You have two kinds of reference material:",
        '- "KB Q/A answers": reusable answer text from Uprise’s internal knowledge base.',
        '- "Relevant contract/context excerpts": snippets taken directly from sample contracts, policies, SOWs, and other uploaded reference documents.',
        "",
        "Use ONLY the information in these references.",
        "If both KB answers and contract/context excerpts are relevant, synthesize them together into a single coherent answer.",
        "Normalize legacy vendor names so that all entities are referred to as 'Uprise Health' where appropriate.",
        "",
        'If there is truly no relevant information at all, respond exactly: Information not found in KB.',
        "",
        "Question:",
        qRaw,
        "",
        "Reference material:",
        candidateBlock,
      ].join("\n");

      let aiAnswer = "Information not found in KB.";

      try {
        if (deduped.length > 0 || ctxSlices.length > 0) {
          const resp = await fetch(
            "https://api.openai.com/v1/chat/completions",
            {
              method: "POST",
              headers: {
                authorization: "Bearer " + OPENAI_KEY,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                model: MODEL,
                messages: [{ role: "user", content: prompt }],
                temperature: 0.25,
              }),
            }
          );

          const data = await resp.json();
          const modelAnswer =
            data &&
            Array.isArray(data.choices) &&
            data.choices[0] &&
            data.choices[0].message &&
            typeof data.choices[0].message.content === "string"
              ? data.choices[0].message.content.trim()
              : "";
          if (modelAnswer.length > 0) {
            aiAnswer = normalizeVendorNames(modelAnswer);
          }
        }
      } catch (err) {
        console.error("GPT error:", err);
      }

      if (needsNumeric(qRaw) && /[0-9%]/.test(aiAnswer) === false) {
        aiAnswer = "N/A (not available in KB).";
      }

      const contextual: MatchItem[] =
        deduped.length > 0
          ? [
              {
                source:
                  deduped[0].source || deduped[0].origin || "Unknown source",
                snippet: safeSnippet(deduped[0].answer),
              },
            ]
          : [];

      const lexicalSorted = [...deduped].sort(
        (a, b) => (b.lexicalScore || 0) - (a.lexicalScore || 0)
      );

      const rawText: MatchItem[] = [];
      if (lexicalSorted.length > 0) {
        if (contextual.length === 0) {
          const m0 = lexicalSorted[0];
          rawText.push({
            source: m0.source || m0.origin || "Unknown source",
            snippet: safeSnippet(m0.answer),
          });
        } else {
          for (const m of lexicalSorted) {
            const snip = safeSnippet(m.answer);
            if (snip === contextual[0].snippet) {
              continue;
            }
            rawText.push({
              source: m.source || m.origin || "Unknown source",
              snippet: snip,
            });
            break;
          }
        }
      }

      const contextChunks: MatchItem[] = (ctxSlices || []).map((c) => ({
        source: c.source || c.origin || "Unknown source",
        snippet: safeSnippet(c.content || c.answer || c.question || ""),
      }));

      const sourcesUsedSet = new Set<string>();

      for (const m of deduped) {
        sourcesUsedSet.add(norm(m.source || m.origin || "Unknown source"));
      }
      for (const c of ctxSlices) {
        sourcesUsedSet.add(norm(c.source || c.origin || "Unknown source"));
      }

      items.push({
        question: qRaw,
        aiAnswer,
        sourcesUsed: Array.from(sourcesUsedSet),
        contextualMatches: contextual,
        rawTextMatches: rawText,
        contextChunks,
      });
    }

    const analyst = await buildAnalystDocx(items, filename);
    const simple = await buildSimpleDocx(items, filename);

    let replica: Buffer | null = null;
    let replicaExt = "docx";

    if (/\.(xlsx|xlsm|xls)$/i.test(lower)) {
      replica = buildReplicaWorkbookFromOriginalXlsx(items, buf);
      replicaExt = "xlsx";
    } else if (/\.docx$/i.test(lower)) {
      replica = await buildReplicaDocxFromOriginalDocx(items, buf);
      replicaExt = "docx";
    } else {
      replica = await buildReplicaDocx(items, filename);
      replicaExt = "docx";
    }

    const xlsx = await buildXlsxReport(items, filename);

    const zip = new JSZip();
    zip.file(base + "_Analyst_Report.docx", analyst);
    zip.file(base + "_Simple_QA.docx", simple);
    if (replica) {
      zip.file(base + "_Replica_Answers." + replicaExt, replica);
    }
    zip.file(base + "_QA.xlsx", xlsx);

    const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });

    return NextResponse.json({
      ok: true,
      totalQuestions: items.length,
      zip: {
        filename: base + "_ALL_REPORTS.zip",
        mime: "application/zip",
        data: zipBuffer.toString("base64"),
      },
    });
  } catch (err: any) {
    console.error("GEN_REPORT_ERROR", err);
    return NextResponse.json({ ok: false, error: err.message });
  }
}

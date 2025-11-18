/**
 * app/api/generate-report/route.ts
 * FINAL FIX - Uprise Health ALWAYS allowed
 * Addresses NEVER redacted
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import JSZip from "jszip";
import * as XLSX from "xlsx";

import { parseUnified } from "@/lib/unifiedParser";
import { getEmbedding } from "@/lib/embed";
import { retrieveMatches } from "@/lib/kb";

import { buildAnalystDocx } from "@/lib/buildAnalystDocx";
import { buildSimpleDocx } from "@/lib/buildSimpleDocx";
import { buildReplicaDocx } from "@/lib/fillReplicaDocx";
import { buildXlsxReport } from "@/lib/buildXlsxReport";
import { buildReplicaWorkbookFromXlsx } from "@/lib/reportBuilder";

/* -----------------------------------
   GLOBAL SAFE TERMS
------------------------------------ */

// NEVER redact these (exact or case-insensitive)
const SAFE_TERMS = [
  "Uprise Health",
  "UPRISE HEALTH",
  "uprise health",
];

/* -----------------------------------
   ADDRESS + COMPANY PROTECTION
------------------------------------ */

// NOTE: These helpers are left here for future use,
// but WE DO NOT CALL THEM from sanitizeForDocx anymore.

function protectAddresses(text: string): string {
  if (!text) return text;

  return text
    // City + State (Irvine CA / New York NY)
    .replace(
      /\b([A-Z][a-z]+)\s+(CA|NY|TX|FL|WA|OR|AZ|CO|IL|NC|SC|GA|VA|NJ|MA|OH|PA|MI)\b/g,
      "__ADDR_CITYSTATE__$1__$2__"
    )
    // Street numbers + words (2 Park Plaza, 123 Main Street)
    .replace(
      /\b(\d{1,5})\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/g,
      "__ADDR_STREET__$1__$2__"
    );
}

function restoreAddresses(text: string): string {
  if (!text) return text;

  return text
    .replace(/__ADDR_CITYSTATE__(.*?)__(.*?)__/g, "$1 $2")
    .replace(/__ADDR_STREET__(\d{1,5})__(.*?)__/g, "$1 $2");
}

/* -----------------------------------
   NAME STRIPPING (DISABLED FOR REPORTS)
------------------------------------ */

// We keep this function defined for backwards compatibility,
// BUT sanitizeForDocx NO LONGER CALLS IT. It is effectively a no-op
// for the report pipeline so we stop "every other word" redactions.
function stripPersonalNames(text: string): string {
  return text || "";
}

/* -----------------------------------
   DOCX SANITIZER
------------------------------------ */

export function sanitizeForDocx(input: any): string {
  let s = (input ?? "").toString();

  // strip control chars
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");

  // remove unpaired surrogates
  s = s.replace(
    /([\uD800-\uDBFF])(?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])([\uDC00-\uDFFF])/g,
    ""
  );

  // IMPORTANT: we DO NOT call stripPersonalNames here anymore.
  // No generic "First Last" redaction in reports.

  return s.trim();
}

/* ---------------------------------- Helpers --------------------------------- */

const MODEL = "gpt-4o-mini";
const TOP_K = 10;
const MIN_SCORE = 0.32;

const Q_HEADER_REGEX = /(question|prompt|rfp\s*item|inquiry|ask)/i;
const A_HEADER_REGEX =
  /(answer|response|reply|details|description|explanation|ai\s*answer)/i;

function norm(s: any) {
  return (s ?? "").toString().replace(/\s+/g, " ").trim();
}

function normalizeVendorNames(text: string) {
  if (!text) return text;
  return text.replace(
    /\b(H.?C\s*HealthWorks|HMC\s*HealthWorks|HMC\b|IBH\b|Claremont\s+Behavioral\s+Health)\b/gi,
    "Uprise Health"
  );
}

function needsNumeric(q: string) {
  const t = q.toLowerCase();
  return /# of|number of|how many|count|percentage|%|rate|current\s+app\s+store/.test(
    t
  );
}

function safeSnippet(s: string) {
  try {
    return normalizeVendorNames(norm(s));
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
};

/* ---------------------------------------------------------------------------
   MAIN REPORT GENERATION ROUTE
--------------------------------------------------------------------------- */

export async function POST(req: NextRequest) {
  console.log("[REPORT] ZIP-enabled route active");

  try {
    const form = await req.formData();
    const file = form.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ ok: false, error: "No file provided" });
    }

    const filename = file.name || "RFP_input";
    const base = filename.replace(/\.[^.]+$/, "");
    const lower = filename.toLowerCase();
    const buf = Buffer.from(await file.arrayBuffer());

    console.log("Parsing document:", filename);
    const parsed = await parseUnified(buf, filename);

    if (!parsed.length) {
      return NextResponse.json({
        ok: false,
        error: "No valid questions found in file",
      });
    }

    const OPENAI_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_KEY) throw new Error("Missing OPENAI_API_KEY");

    const items: QAItem[] = [];

    for (let i = 0; i < parsed.length; i++) {
      const qRaw = norm(parsed[i].question);
      if (!qRaw) continue;

      const emb = await getEmbedding(qRaw);
      const matches = await retrieveMatches(emb, TOP_K, qRaw);

      const good = (matches || []).filter(
        (m: any) => m.score >= MIN_SCORE && m.answer
      );

      const seen = new Set<string>();
      const deduped: any[] = [];

      for (const m of good) {
        const key = norm(m.answer).toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          deduped.push(m);
        }
      }

      const candidateBlock =
        deduped.length > 0
          ? deduped
              .map(
                (m, idx) =>
                  "[Answer " +
                  (idx + 1) +
                  "]\n" +
                  normalizeVendorNames(norm(m.answer))
              )
              .join("\n\n")
          : "(none)";

      const prompt = [
        "You are an expert RFP analyst for Uprise Health.",
        "Use ONLY facts from the candidate answers.",
        "Normalize legacy vendor names.",
        "If nothing applies, respond exactly: Information not found in KB.",
        "",
        "Question:",
        qRaw,
        "",
        "Candidate answers:",
        candidateBlock,
      ].join("\n");

      let aiAnswer = "Information not found in KB.";

      try {
        const resp = await fetch("https://api.openai.com/v1/chat/completions", {
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
        });

        const data = await resp.json();
        aiAnswer = normalizeVendorNames(
          data?.choices?.[0]?.message?.content?.trim() || aiAnswer
        );
      } catch (err) {
        console.error("GPT error:", err);
      }

      if (needsNumeric(qRaw) && !/[0-9%]/.test(aiAnswer)) {
        aiAnswer = "N/A (not available in KB).";
      }

      const contextual: MatchItem[] =
        deduped[0]
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
      for (const m of lexicalSorted) {
        const snip = safeSnippet(m.answer);
        if (!contextual[0] || snip !== contextual[0].snippet) {
          rawText.push({
            source: m.source || m.origin || "Unknown source",
            snippet: snip,
          });
          break;
        }
      }

      items.push({
        question: qRaw,
        aiAnswer,
        sourcesUsed: deduped.map((m) => norm(m.source || "Unknown source")),
        contextualMatches: contextual,
        rawTextMatches: rawText,
      });
    }

    const analyst = await buildAnalystDocx(items, filename);
    const simple = await buildSimpleDocx(items, filename);

    // Always use DOCX replica (stable)
    const replica = await buildReplicaDocx(items, filename);
    const replicaExt = "docx";

    const xlsx = await buildXlsxReport(items, filename);

    const zip = new JSZip();
    zip.file(base + "_Analyst_Report.docx", analyst);
    zip.file(base + "_Simple_QA.docx", simple);
    zip.file(base + "_Replica_Answers." + replicaExt, replica);
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

/**
 * app/api/generate-report/route.ts
 * - No name redaction in outputs (DOCX sanitizer only cleans control chars)
 * - Policy layer on answers:
 *    - Omit individual human names in answers
 *    - Never answer female/woman-owned/leadership-gender questions directly
 *    - Always respond with Irvine, CA for Uprise HQ/location questions
 * - For XLSX uploads, Replica_Answers.xlsx is the ORIGINAL workbook
 *   with AI answers written into the answer column.
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
   DOCX SANITIZER (reports only)
   - No redaction, just control-char cleanup
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

/* ----------------------------------
   Policy helpers (ownership / names / location)
------------------------------------ */

function normalizeUpriseLocation(text: string): string {
  if (!text) return text;
  let out = text;

  // Kill legacy/bad HQ references
  out = out.replace(/\bJupiter,\s*FL(?:orida)?\b/gi, "Irvine, CA");
  out = out.replace(/\bJupiter\s+Florida\b/gi, "Irvine, CA");

  return out;
}

function scrubIndividualNames(text: string): string {
  if (!text) return text;

  let out = text;

  // preserve company name spelling
  SAFE_TERMS.forEach((t) => {
    out = out.replace(new RegExp(t, "gi"), t);
  });

  // Titles + names (Dr. Jane Doe -> "Dr.")
  out = out.replace(
    /\b(Dr\.|Mr\.|Ms\.|Mrs\.|Prof\.)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g,
    "$1"
  );

  // Obvious "First Last" personal names, but avoid corporate suffixes
  const NON_PEOPLE_WORDS = [
    "Health",
    "Center",
    "Plaza",
    "Building",
    "Services",
    "Corp",
    "LLC",
    "Inc",
    "Systems",
    "Solutions",
    "Behavioral",
  ];

  out = out.replace(
    /\b([A-Z][a-z]+)\s+([A-Z][a-z]+)\b/g,
    (match: string, first: string, last: string) => {
      const combined = first + " " + last;

      // Preserve explicit safe terms
      if (
        SAFE_TERMS.some(
          (t) => t.toLowerCase() === combined.toLowerCase()
        )
      ) {
        return combined;
      }

      // Preserve corporate / non-person endings
      if (NON_PEOPLE_WORDS.indexOf(last) !== -1) return combined;

      // Otherwise treat as personal name
      return "[redacted]";
    }
  );

  return out;
}

function scrubFemaleOwnershipClaims(text: string): string {
  if (!text) return text;
  let out = text;

  // Woman-owned / female-owned / similar claims
  out = out.replace(
    /\b(female|woman|women)[-\s]?owned\b[^.]*\./gi,
    "Ownership or leadership demographics are not provided in this context."
  );

  // Leadership gender claims
  out = out.replace(
    /\b(female|woman|women)[-\s]?(ceo|cfo|founder|owner|leader|chair|executive|president)\b[^.]*\./gi,
    "Leadership demographics are not provided in this context."
  );

  return out;
}

function isFemaleOwnershipQuestion(q: string): boolean {
  const t = norm(q).toLowerCase();
  return /woman[-\s]?owned|women[-\s]?owned|female[-\s]?owned|minority[-\s]?owned|women[-\s]led|female[-\s]led/.test(
    t
  );
}

function isLeadershipGenderQuestion(q: string): boolean {
  const t = norm(q).toLowerCase();
  return /(male|female|woman|women)\s+(ceo|cfo|founder|owner|leader|chair|executive|president)/.test(
    t
  );
}

function isLocationQuestion(q: string): boolean {
  const t = norm(q).toLowerCase();
  return /(headquarters?|hq|where.*uprise.*located|uprise health location|primary office location|corporate headquarters)/.test(
    t
  );
}

function applyUprisePolicy(question: string, answer: string): string {
  let a = norm(answer);

  // Direct policy overrides based on the question itself
  if (isFemaleOwnershipQuestion(question) || isLeadershipGenderQuestion(question)) {
    return "Ownership and leadership demographics (including gender or minority status) are not provided; we encourage focusing on Uprise Health’s services and capabilities instead.";
  }

  if (isLocationQuestion(question)) {
    return "Uprise Health is headquartered in Irvine, CA.";
  }

  // Otherwise, clean the text
  a = normalizeUpriseLocation(a);
  a = scrubFemaleOwnershipClaims(a);
  a = scrubIndividualNames(a);

  return a;
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
   XLSX REPLICA HELPER – EDIT ORIGINAL WORKBOOK IN PLACE
--------------------------------------------------------------------------- */

function buildReplicaWorkbookFromOriginalXlsx(
  items: QAItem[],
  originalBuffer: Buffer
): Buffer {
  // 1) Load original workbook
  const wb = XLSX.read(originalBuffer, { type: "buffer" });

  // 2) Build lookup: question text -> aiAnswer (lowercased key)
  const qaMap = new Map<string, string>();
  for (const item of items) {
    const qKey = norm(item.question).toLowerCase();
    if (!qKey) continue;
    if (!qaMap.has(qKey)) {
      qaMap.set(qKey, item.aiAnswer || "Information not found in KB.");
    }
  }

  // 3) Walk each sheet and update answer cells
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    if (!ws || !ws["!ref"]) continue;

    const range = XLSX.utils.decode_range(ws["!ref"]);
    if (range.s.r > range.e.r || range.s.c > range.e.c) continue;

    // Assume first row is header row (same assumption as parseUnified)
    const headerRow = range.s.r;

    // Discover question and answer columns from header names
    let qCol: number | null = null;
    let aCol: number | null = null;

    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r: headerRow, c });
      const cell = ws[addr];
      const header = norm(cell && (cell.v ?? cell.w));
      if (!header) continue;

      if (qCol === null && Q_HEADER_REGEX.test(header)) qCol = c;
      if (aCol === null && A_HEADER_REGEX.test(header)) aCol = c;
    }

    // Fallbacks:
    // - If no explicit question header, use first column as Q
    // - If no explicit answer header, use next column as A (or same if none)
    if (qCol === null) qCol = range.s.c;
    if (aCol === null) {
      aCol = qCol + 1 <= range.e.c ? qCol + 1 : qCol;
    }

    // 4) Update data rows
    for (let r = headerRow + 1; r <= range.e.r; r++) {
      const qAddr = XLSX.utils.encode_cell({ r, c: qCol });
      const qCell = ws[qAddr];
      const qText = norm(qCell && (qCell.v ?? qCell.w));
      if (!qText) continue;

      const key = qText.toLowerCase();
      const aiAnswer = qaMap.get(key);
      if (!aiAnswer) continue; // no AI answer for this question

      const aAddr = XLSX.utils.encode_cell({ r, c: aCol });
      const existing = ws[aAddr] || {};
      ws[aAddr] = {
        ...existing,
        t: "s",
        v: aiAnswer,
      };
    }
  }

  // 5) Write back to buffer as XLSX (same structure, filled answers)
  const out = XLSX.write(wb, { bookType: "xlsx", type: "buffer" }) as Buffer;
  return Buffer.from(out);
}

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
        "Do NOT include any individual people’s names in your answer; refer to roles or teams instead.",
        "If the question asks whether Uprise Health is woman-owned, female-owned, minority-owned, or about the gender of owners or executives, do NOT answer that directly; instead say that ownership and leadership demographics are not provided and focus on services and capabilities.",
        "If the question is about Uprise Health’s headquarters or location, always answer that Uprise Health is headquartered in Irvine, CA.",
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

      // 🔒 Apply hard policy (names, female ownership, HQ location)
      aiAnswer = applyUprisePolicy(qRaw, aiAnswer);

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

    // Replica: for XLSX uploads, edit original workbook in place
    let replica: Buffer | null = null;
    let replicaExt = "docx";

    if (/\.(xlsx|xlsm|xls)$/i.test(lower)) {
      replica = buildReplicaWorkbookFromOriginalXlsx(items, buf);
      replicaExt = "xlsx";
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

import { parse } from "csv-parse/sync";
import * as XLSX from "xlsx";
import mammoth from "mammoth";
import pdfParse from "pdf-parse";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

export type QAPair = {
  question: string;
  answer: string;
  source?: string;
};

const Q_HEADER_REGEX = /(question|prompt|rfp\s*item|inquiry|ask)/i;
const A_HEADER_REGEX = /(answer|response|reply|details|description|explanation)/i;

function norm(s: any) {
  return (s ?? "").toString().replace(/\s+/g, " ").trim();
}

function dedupe(pairs: QAPair[]): QAPair[] {
  const seen = new Set<string>();
  const out: QAPair[] = [];
  for (const p of pairs) {
    const k = norm(p.question).toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push({ question: norm(p.question), answer: norm(p.answer), source: p.source });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* CSV + XLSX (now supports Q-only rows) */
/* -------------------------------------------------------------------------- */

function extractPairsFromCSV(buf: Buffer, source: string): QAPair[] {
  const text = buf.toString("utf8");
  const delimiter = text.includes("\t") ? "\t" : ",";
  const records = parse(text, {
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
    delimiter,
  });

  const pairs: QAPair[] = [];
  for (const row of records) {
    const keys = Object.keys(row);
    if (!keys.length) continue;

    const qKey = keys.find((k) => Q_HEADER_REGEX.test(k)) ?? keys[0];
    const aKey = keys.find((k) => A_HEADER_REGEX.test(k)) ?? keys[1];
    const q = norm(row[qKey]);
    const a = norm(aKey ? row[aKey] : "");

    if (q) pairs.push({ question: q, answer: a || "", source });
  }

  console.log(`[PARSER] CSV extracted ${pairs.length} total rows (Q/A or Q-only)`);
  return dedupe(pairs);
}

function extractPairsFromXLSX(buf: Buffer, source: string): QAPair[] {
  const wb = XLSX.read(buf, { type: "buffer" });
  const all: QAPair[] = [];

  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    const json = XLSX.utils.sheet_to_json<Record<string, any>>(sheet, { defval: "" });
    for (const row of json) {
      const keys = Object.keys(row);
      if (!keys.length) continue;

      const qKey = keys.find((k) => Q_HEADER_REGEX.test(k)) ?? keys[0];
      const aKey = keys.find((k) => A_HEADER_REGEX.test(k)) ?? keys[1];
      const q = norm(row[qKey]);
      const a = norm(aKey ? row[aKey] : "");
      if (q) all.push({ question: q, answer: a || "", source });
    }
  }

  console.log(`[PARSER] XLSX extracted ${all.length} total rows (Q/A or Q-only)`);
  return dedupe(all);
}

/* -------------------------------------------------------------------------- */
/* DOCX + TXT + PDF */
/* -------------------------------------------------------------------------- */

async function extractFromDOCX(buf: Buffer, source: string): Promise<QAPair[]> {
  const res = await mammoth.extractRawText({ buffer: buf });
  const lines = res.value.split(/\r?\n+/).map(norm).filter(Boolean);
  const pairs: QAPair[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].endsWith("?")) {
      pairs.push({ question: lines[i], answer: lines[i + 1] || "", source });
    }
  }

  console.log(`[PARSER] DOCX extracted ${pairs.length} Q/A or Q-only`);
  return dedupe(pairs);
}

function extractFromTXT(buf: Buffer, source: string): QAPair[] {
  const lines = buf.toString("utf8").split(/\r?\n+/).map(norm).filter(Boolean);
  const pairs: QAPair[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].endsWith("?")) {
      pairs.push({ question: lines[i], answer: lines[i + 1] || "", source });
    }
  }

  console.log(`[PARSER] TXT extracted ${pairs.length} Q/A or Q-only`);
  return dedupe(pairs);
}

async function extractFromPDF(buf: Buffer, source: string): Promise<QAPair[]> {
  try {
    const data = await pdfParse(buf);
    const text = norm(data.text);
    if (text.length < 200) {
      console.warn("[PARSER] PDF text too short — using fallback");
      return extractQuestionsFromText(text, source);
    }
    return extractQuestionsFromText(text, source);
  } catch (err) {
    console.error("[PDF_PARSE_ERROR]", err);
    return [];
  }
}

function extractQuestionsFromText(text: string, source: string): QAPair[] {
  const lines = text.split(/\r?\n+/).map(norm).filter(Boolean);
  const out: QAPair[] = [];
  for (const line of lines) {
    if (/\?$/.test(line) && line.length > 5) {
      out.push({ question: line, answer: "", source });
    }
  }
  console.log(`[PARSER] Fallback text question-only extraction: ${out.length}`);
  return dedupe(out);
}

/* -------------------------------------------------------------------------- */
/* Main entry */
/* -------------------------------------------------------------------------- */

export async function parseUnified(buf: Buffer, filename: string): Promise<QAPair[]> {
  const lower = (filename || "").toLowerCase();
  const source = filename.replace(/\.[^.]+$/, "");
  try {
    if (lower.endsWith(".csv")) return extractPairsFromCSV(buf, source);
    if (/\.(xlsx|xlsm|xls)$/i.test(lower)) return extractPairsFromXLSX(buf, source);
    if (lower.endsWith(".docx")) return await extractFromDOCX(buf, source);
    if (lower.endsWith(".pdf")) return await extractFromPDF(buf, source);
    if (/\.(txt|md)$/i.test(lower)) return extractFromTXT(buf, source);

    return extractQuestionsFromText(buf.toString("utf8"), source);
  } catch (err) {
    console.error("[PARSER_ERROR]", err);
    return [];
  }
}

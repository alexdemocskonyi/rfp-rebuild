// lib/unifiedParser.ts
import { parse } from "csv-parse/sync";
import * as XLSX from "xlsx";
import mammoth from "mammoth";
import pdf from "pdf-parse-fixed";

export type QAPair = {
  question: string;
  answer: string;
  source?: string;
  isFileRequest?: boolean;
};

const Q_HEADER_REGEX = /(question|prompt|rfp\s*item|inquiry|ask)/i;
const A_HEADER_REGEX = /(answer|response|reply|details|description|explanation)/i;

function norm(s: any) {
  return (s ?? "").toString().replace(/\s+/g, " ").trim();
}

function isBadAnswer(a: string) {
  return (
    !a ||
    a === "." ||
    a === "-" ||
    /^["']?[A-Za-z]?\W*$/.test(a) ||
    a.match(/^\(?\s*200 words\s*\)?$/i) !== null
  );
}

function redact(a: string) {
  return norm(a)
    // strip Dr. First Last
    .replace(/Dr\.\s+[A-Z][a-z]+\s+[A-Z][a-z]+/g, "")
    // SOC2 wording normalization
    .replace(
      /\bUprise\s+Health\s+is\s+SOC2\s+certified\b/gi,
      "Uprise Health systems are hosted on SOC2-certified platforms"
    )
    // emails
    .replace(/\b[\w.-]+@[\w.-]+\.\w+\b/g, "")
    // bad legacy location noise
    .replace(/juniper\s+florida/gi, "")
    .replace(
      /2\s+Park\s+Plaza\s+Suite\s+1200\s+Irvine\s+CA\s+92614/gi,
      ""
    )
    .trim();
}

function isFileReq(q: string) {
  return /(attach|include|submit|upload|provide|copy of|furnish).*(document|file|certificate|policy|form)/i.test(
    q
  );
}

function dedupe(pairs: QAPair[]): QAPair[] {
  const seen = new Set<string>();
  return pairs.filter((p) => {
    const key = norm(p.question).toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Heuristic: does this line look like a question line?
 * - ends with "?"
 * - OR starts with a numbered item like "1. ", "10) ", "3)   "
 * - OR starts with "Question 1:" / "Q1:" style.
 */
function looksLikeQuestionLine(line: string): boolean {
  const t = norm(line);
  if (!t) return false;

  // plain question
  if (t.endsWith("?")) return true;

  // numbered items: "1. Text", "2) Text", "10) Text"
  if (/^\d+\s*[\.\)]\s+/.test(t)) return true;

  // "Question 1:" / "Q1:" / "Question:"
  if (/^(question|q)\s*\d*\s*[:.)]\s*/i.test(t)) return true;

  return false;
}

function extractFromRows(rows: Record<string, any>[], src: string): QAPair[] {
  const out: QAPair[] = [];
  for (const r of rows) {
    const keys = Object.keys(r);
    if (!keys.length) continue;

    const qKey =
      keys.find((k) => Q_HEADER_REGEX.test(k)) ?? keys[0];
    const aKey =
      keys.find((k) => A_HEADER_REGEX.test(k)) ?? keys[1];

    const q = norm(r[qKey]);
    let a = norm(aKey != null ? r[aKey] : "");

    if (!q) continue;

    const pair: QAPair = { question: q, answer: "", source: src };
    if (!isBadAnswer(a)) pair.answer = redact(a);
    if (isFileReq(q)) pair.isFileRequest = true;

    out.push(pair);
  }
  return out;
}

function extractPairsFromCSV(buf: Buffer, src: string): QAPair[] {
  const text = buf.toString("utf8");
  const delimiter = text.includes("\t") ? "\t" : ",";
  const records = parse(text, {
    columns: true,
    skip_empty_lines: true,
    delimiter,
  });
  return dedupe(extractFromRows(records, src));
}

function extractPairsFromXLSX(buf: Buffer, src: string): QAPair[] {
  const wb = XLSX.read(buf, { type: "buffer" });
  const all: QAPair[] = [];
  for (const name of wb.SheetNames) {
    const json = XLSX.utils.sheet_to_json(wb.Sheets[name], {
      defval: "",
    });
    all.push(...extractFromRows(json as any[], src));
  }
  return dedupe(all);
}

async function extractFromDOCX(
  buf: Buffer,
  src: string
): Promise<QAPair[]> {
  const res = await mammoth.extractRawText({ buffer: buf });
  const lines = res.value
    .split(/\r?\n+/)
    .map(norm)
    .filter(Boolean);

  const out: QAPair[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!looksLikeQuestionLine(line)) continue;

    const next = lines[i + 1] ?? "";
    out.push({
      question: line,
      answer: redact(next),
      source: src,
      isFileRequest: isFileReq(line),
    });
  }

  return dedupe(out);
}

function extractFromTXT(buf: Buffer, src: string): QAPair[] {
  const lines = buf
    .toString("utf8")
    .split(/\r?\n+/)
    .map(norm)
    .filter(Boolean);

  const out: QAPair[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!looksLikeQuestionLine(line)) continue;

    const next = lines[i + 1] ?? "";
    out.push({
      question: line,
      answer: redact(next),
      source: src,
      isFileRequest: isFileReq(line),
    });
  }

  return dedupe(out);
}

async function extractFromPDF(
  buf: Buffer,
  src: string
): Promise<QAPair[]> {
  try {
    const data = await pdf(buf);
    const lines = norm(data.text)
      .split(/\r?\n+/)
      .map(norm)
      .filter(Boolean);

    const out: QAPair[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!looksLikeQuestionLine(line)) continue;

      const next = lines[i + 1] ?? "";
      out.push({
        question: line,
        answer: redact(next),
        source: src,
        isFileRequest: isFileReq(line),
      });
    }

    return dedupe(out);
  } catch {
    return [];
  }
}

export async function parseUnified(
  buf: Buffer,
  filename: string
): Promise<QAPair[]> {
  const lower = filename.toLowerCase();
  const src = filename.replace(/\.[^.]+$/, "");

  if (lower.endsWith(".csv")) return extractPairsFromCSV(buf, src);
  if (/\.(xlsx|xlsm|xls)$/i.test(lower))
    return extractPairsFromXLSX(buf, src);
  if (lower.endsWith(".docx")) return await extractFromDOCX(buf, src);
  if (lower.endsWith(".pdf")) return await extractFromPDF(buf, src);

  // default: treat as plain text
  return extractFromTXT(buf, src);
}

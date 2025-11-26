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
const A_HEADER_REGEX =
  /(answer|response|reply|details|description|explanation|ai\s*answer)/i;
// Explicit SOURCE-like headers for spreadsheets
const SOURCE_HEADER_REGEX = /(source|origin|reference|ref)/i;

function norm(s: any) {
  return (s ?? "").toString().replace(/\s+/g, " ").trim();
}

function isBadAnswer(a: string) {
  const t = norm(a);
  return (
    !t ||
    t === "." ||
    t === "-" ||
    /^["']?[A-Za-z]?\W*$/.test(t) ||
    /^\(?\s*200 words\s*\)?$/i.test(t)
  );
}

function redact(a: string) {
  return norm(a)
    // strip "Dr. First Last"
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
    .replace(/2\s+Park\s+Plaza\s+Suite\s+1200\s+Irvine\s+CA\s+92614/gi, "")
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

  if (t.endsWith("?")) return true;

  if (/^\d+\s*[\.\)]\s+/.test(t)) return true;

  if (/^(question|q)\s*\d*\s*[:.)]\s*/i.test(t)) return true;

  return false;
}

/**
 * Fallback for contracts / context docs:
 * Turn raw text into reusable context chunks stored as Q/A pairs.
 * - question: "Context from <src> (section N) – <snippet>"
 * - answer: the full chunk text
 */
function extractContextChunksFromText(text: string, src: string): QAPair[] {
  const cleaned = norm(text);
  if (!cleaned) {
    console.log("[PARSER] Context fallback: no text for", src);
    return [];
  }

  const maxChunkChars = 1200;
  const minChunkChars = 200;

  const paragraphs = cleaned
    .split(/\n{2,}/)
    .map((p) => norm(p))
    .filter((p) => p.length >= minChunkChars);

  if (!paragraphs.length) {
    console.log(
      "[PARSER] Context fallback: 0 paragraphs >=",
      minChunkChars,
      "chars for",
      src
    );
  }

  const out: QAPair[] = [];
  let section = 1;

  for (const para of paragraphs) {
    for (let i = 0; i < para.length; i += maxChunkChars) {
      const chunk = para.slice(i, i + maxChunkChars).trim();
      if (!chunk) continue;
      if (chunk.length < minChunkChars && paragraphs.length > 1) continue;

      let end = chunk.search(/[.?!]\s/);
      if (end === -1 || end > 220) end = Math.min(220, chunk.length);
      let snippet = chunk.slice(0, end + 1).trim();
      if (snippet.length > 240) {
        snippet = snippet.slice(0, 237) + "…";
      }

      const question = `Context from ${src} (section ${section}) – ${snippet}`;

      out.push({
        question,
        answer: chunk,
        source: src,
      });

      section += 1;
    }
  }

  console.log(
    "[PARSER] Context fallback produced",
    out.length,
    "chunks for",
    src
  );

  return out;
}

function extractFromRows(rows: Record<string, any>[], src: string): QAPair[] {
  const out: QAPair[] = [];

  for (const r of rows) {
    const keys = Object.keys(r);
    if (!keys.length) continue;

    const qKey = keys.find((k) => Q_HEADER_REGEX.test(k)) ?? keys[0];

    const aKey =
      keys.find((k) => A_HEADER_REGEX.test(k)) ??
      (keys.length > 1 ? keys[1] : undefined);

    // Look for a SOURCE-style column
    const sKey = keys.find((k) => SOURCE_HEADER_REGEX.test(k));

    const q = norm(r[qKey]);
    const aRaw = aKey != null ? norm(r[aKey]) : "";
    const srcCell = sKey != null ? norm(r[sKey]) : "";

    if (!q) continue;

    let answer = "";
    if (!isBadAnswer(aRaw)) {
      answer = redact(aRaw);
    }

    const pair: QAPair = {
      question: q,
      answer,
      source: srcCell || src,
    };

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

async function extractFromDOCX(buf: Buffer, src: string): Promise<QAPair[]> {
  console.log("[PARSER] DOCX path for", src, "buf bytes", buf.byteLength);
  const res = await mammoth.extractRawText({ buffer: buf });
  const text = res.value || "";
  console.log("[PARSER] DOCX extracted chars", text.length, "for", src);

  const lines = text
    .split(/\r?\n+/)
    .map(norm)
    .filter(Boolean);

  const out: QAPair[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!looksLikeQuestionLine(line)) continue;

    const next = lines[i + 1] ?? "";
    const aRaw = norm(next);
    if (isBadAnswer(aRaw)) continue;

    out.push({
      question: line,
      answer: redact(aRaw),
      source: src,
      isFileRequest: isFileReq(line),
    });
  }

  if (out.length === 0) {
    console.log(
      "[PARSER] DOCX produced 0 Q/A pairs; using context fallback for",
      src
    );
    return extractContextChunksFromText(text, src);
  }

  console.log("[PARSER] DOCX produced", out.length, "Q/A pairs for", src);
  return dedupe(out);
}

function extractFromTXT(buf: Buffer, src: string): QAPair[] {
  const text = buf.toString("utf8");
  const lines = text
    .split(/\r?\n+/)
    .map(norm)
    .filter(Boolean);

  const out: QAPair[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!looksLikeQuestionLine(line)) continue;

    const next = lines[i + 1] ?? "";
    const aRaw = norm(next);
    if (isBadAnswer(aRaw)) continue;

    out.push({
      question: line,
      answer: redact(next),
      source: src,
      isFileRequest: isFileReq(line),
    });
  }

  if (out.length === 0) {
    console.log("[PARSER] TXT produced 0 Q/A pairs; using context fallback for", src);
    return extractContextChunksFromText(text, src);
  }

  console.log("[PARSER] TXT produced", out.length, "Q/A pairs for", src);
  return dedupe(out);
}

async function extractFromPDF(buf: Buffer, src: string): Promise<QAPair[]> {
  console.log("[PARSER] PDF path for", src, "buf bytes", buf.byteLength);
  try {
    const data = await pdf(buf);
    const text = norm(data.text);
    console.log("[PARSER] PDF extracted chars", text.length, "for", src);

    const lines = text
      .split(/\r?\n+/)
      .map(norm)
      .filter(Boolean);

    const out: QAPair[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!looksLikeQuestionLine(line)) continue;

      const next = lines[i + 1] ?? "";
      const aRaw = norm(next);
      if (isBadAnswer(aRaw)) continue;

      out.push({
        question: line,
        answer: redact(aRaw),
        source: src,
        isFileRequest: isFileReq(line),
      });
    }

    if (out.length === 0) {
      console.log(
        "[PARSER] PDF produced 0 Q/A pairs; using context fallback for",
        src
      );
      return extractContextChunksFromText(text, src);
    }

    console.log("[PARSER] PDF produced", out.length, "Q/A pairs for", src);
    return dedupe(out);
  } catch (err) {
    console.error("[PARSER] PDF error for", src, err);
    return [];
  }
}

export async function parseUnified(
  buf: Buffer,
  filename: string
): Promise<QAPair[]> {
  const lower = filename.toLowerCase();
  const src = filename.replace(/\.[^.]+$/, "");
  console.log("[PARSER] parseUnified for", filename);

  if (lower.endsWith(".csv")) return extractPairsFromCSV(buf, src);
  if (/\.(xlsx|xlsm|xls)$/i.test(lower)) return extractPairsFromXLSX(buf, src);
  if (lower.endsWith(".docx")) return await extractFromDOCX(buf, src);
  if (lower.endsWith(".pdf")) return await extractFromPDF(buf, src);

  // default: treat as plain text
  return extractFromTXT(buf, src);
}

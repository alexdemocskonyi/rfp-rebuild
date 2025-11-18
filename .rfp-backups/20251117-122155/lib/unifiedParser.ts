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
  return !a || a === "." || a === "-" || /^["']?[A-Za-z]?\W*$/.test(a) || a.match(/^\(?\s*200 words\s*\)?$/i);
}

function redact(a: string) {
  return norm(a)
    .replace(/Dr\.\s+[A-Z][a-z]+\s+[A-Z][a-z]+/g, "") // names
    .replace(/\bUprise\s+Health\s+is\s+SOC2\s+certified\b/gi, "Uprise Health systems are hosted on SOC2-certified platforms")
    .replace(/\b[\w.-]+@[\w.-]+\.\w+\b/g, "") // emails
    .replace(/juniper\s+florida/gi, "")
    .replace(/2\s+Park\s+Plaza\s+Suite\s+1200\s+Irvine\s+CA\s+92614/gi, "")
    .trim();
}

function isFileReq(q: string) {
  return /(attach|include|submit|upload|provide|copy of|furnish).*(document|file|certificate|policy|form)/i.test(q);
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

function extractFromRows(rows: Record<string, any>[], src: string): QAPair[] {
  const out: QAPair[] = [];
  for (const r of rows) {
    const keys = Object.keys(r);
    if (!keys.length) continue;
    const q = norm(r[keys.find((k) => Q_HEADER_REGEX.test(k)) ?? keys[0]]);
    let a = norm(r[keys.find((k) => A_HEADER_REGEX.test(k)) ?? keys[1]] ?? "");
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
  const records = parse(text, { columns: true, skip_empty_lines: true, delimiter });
  return dedupe(extractFromRows(records, src));
}

function extractPairsFromXLSX(buf: Buffer, src: string): QAPair[] {
  const wb = XLSX.read(buf, { type: "buffer" });
  const all: QAPair[] = [];
  for (const name of wb.SheetNames) {
    const json = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: "" });
    all.push(...extractFromRows(json as any[], src));
  }
  return dedupe(all);
}

async function extractFromDOCX(buf: Buffer, src: string): Promise<QAPair[]> {
  const res = await mammoth.extractRawText({ buffer: buf });
  const lines = res.value.split(/\r?\n+/).map(norm).filter(Boolean);
  const out: QAPair[] = [];
  for (let i = 0; i < lines.length; i++)
    if (lines[i].endsWith("?"))
      out.push({ question: lines[i], answer: redact(lines[i + 1] || ""), source: src, isFileRequest: isFileReq(lines[i]) });
  return dedupe(out);
}

function extractFromTXT(buf: Buffer, src: string): QAPair[] {
  const lines = buf.toString("utf8").split(/\r?\n+/).map(norm).filter(Boolean);
  const out: QAPair[] = [];
  for (let i = 0; i < lines.length; i++)
    if (lines[i].endsWith("?"))
      out.push({ question: lines[i], answer: redact(lines[i + 1] || ""), source: src, isFileRequest: isFileReq(lines[i]) });
  return dedupe(out);
}

async function extractFromPDF(buf: Buffer, src: string): Promise<QAPair[]> {
  try {
    const data = await pdf(buf);
    const lines = norm(data.text).split(/\r?\n+/).map(norm).filter(Boolean);
    const out: QAPair[] = [];
    for (let i = 0; i < lines.length; i++)
      if (lines[i].endsWith("?"))
        out.push({ question: lines[i], answer: redact(lines[i + 1] || ""), source: src, isFileRequest: isFileReq(lines[i]) });
    return dedupe(out);
  } catch {
    return [];
  }
}

export async function parseUnified(buf: Buffer, filename: string): Promise<QAPair[]> {
  const lower = filename.toLowerCase();
  const src = filename.replace(/\.[^.]+$/, "");
  if (lower.endsWith(".csv")) return extractPairsFromCSV(buf, src);
  if (/\.(xlsx|xlsm|xls)$/i.test(lower)) return extractPairsFromXLSX(buf, src);
  if (lower.endsWith(".docx")) return await extractFromDOCX(buf, src);
  if (lower.endsWith(".pdf")) return await extractFromPDF(buf, src);
  return extractFromTXT(buf, src);
}

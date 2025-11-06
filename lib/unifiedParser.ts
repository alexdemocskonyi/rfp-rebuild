// lib/unifiedParser.ts
import * as XLSX from "xlsx";
import mammoth from "mammoth";

type Q = { question: string; answer?: string };

const HEADER_MATCH = /(question|prompt|question\/prompt|rfp\s*item|inquiry|ask)/i;

function norm(s: string) {
  return s.replace(/\s+/g, " ").trim();
}

function dedupe(questions: Q[]): Q[] {
  const seen = new Set<string>();
  const out: Q[] = [];
  for (const q of questions) {
    const k = norm(q.question).toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push({ question: norm(q.question) });
  }
  return out;
}

function extractQuestionsFromText(text: string): string[] {
  const questions: string[] = [];
  if (!text) return questions;
  // Grab any sentence containing a question mark
  const matches = text.match(/[^.!?\n\r]*\?+[^.!?\n\r]*/g);
  if (matches) {
    for (const m of matches) {
      const q = norm(m);
      if (q.length > 3 && q.includes("?")) questions.push(q);
    }
  }
  return questions;
}

function fromCSV(buf: Buffer): Q[] {
  const text = buf.toString("utf8");
  const lines = text.split(/\r?\n/).filter(l => l.trim().length);
  if (!lines.length) return [];

  // Simple CSV split (handles quoted cells)
  const parseLine = (line: string) =>
    (line.match(/(".*?"|[^",]+)(?=\s*,|\s*$)/g) || []).map(s => s.replace(/^"|"$/g, ""));

  const headerCells = parseLine(lines[0]).map(norm);
  let body = lines;
  let headerColIdx: number | null = null;

  // Detect a header column containing question/prompt
  for (let i = 0; i < Math.min(3, lines.length); i++) {
    const cells = parseLine(lines[i]).map(norm);
    const idx = cells.findIndex(c => HEADER_MATCH.test(c));
    if (idx >= 0) {
      headerColIdx = idx;
      body = lines.slice(i + 1);
      break;
    }
  }

  const out: Q[] = [];
  for (const line of body) {
    const cells = parseLine(line).map(norm);
    if (headerColIdx != null) {
      const v = cells[headerColIdx] || "";
      if (v) out.push({ question: v });
    } else {
      // Fallback: flatten row; prefer ?-sentences; otherwise take first non-empty cell
      const flat = cells.join(" ").trim();
      const qs = extractQuestionsFromText(flat);
      if (qs.length) qs.forEach(q => out.push({ question: q }));
      else if (cells[0]) out.push({ question: cells[0] });
    }
  }
  return dedupe(out);
}

function fromXLSX(buf: Buffer, filename: string): Q[] {
  const wb = XLSX.read(buf, { type: "buffer" });
  const all: Q[] = [];

  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];

    // 1) Try header-aware extraction using header:1 for raw matrix
    const grid: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
    let extracted: Q[] = [];

    if (Array.isArray(grid) && grid.length) {
      // Search first 5 rows for a column header that matches question/prompt
      let headerRow = 0, headerCol: number | null = null;
      for (let r = 0; r < Math.min(5, grid.length); r++) {
        const row = grid[r].map((v: any) => String(v ?? ""));
        const idx = row.findIndex((cell: string) => HEADER_MATCH.test(cell));
        if (idx >= 0) { headerRow = r; headerCol = idx; break; }
      }

      if (headerCol != null) {
        for (let r = headerRow + 1; r < grid.length; r++) {
          const cell = String(grid[r]?.[headerCol] ?? "").trim();
          if (cell) extracted.push({ question: cell });
        }
      } else {
        // 2) No obvious header — flatten each row and extract ?-sentences,
        //     or take the first non-empty cell as a prompt-like line.
        for (let r = 0; r < grid.length; r++) {
          const row = grid[r].map((v: any) => String(v ?? ""));
          const flat = norm(row.join(" "));
          if (!flat) continue;
          const qs = extractQuestionsFromText(flat);
          if (qs.length) qs.forEach(q => extracted.push({ question: q }));
          else if (row[0]) extracted.push({ question: row[0] });
        }
      }
    } else {
      // 3) Ultimate fallback using sheet_to_json objects
      const rows = XLSX.utils.sheet_to_json<Record<string, any>>(sheet, { defval: "" });
      for (const r of rows) {
        const values = Object.values(r).map(v => String(v ?? "")).filter(Boolean);
        const flat = norm(values.join(" "));
        if (!flat) continue;
        const qs = extractQuestionsFromText(flat);
        if (qs.length) qs.forEach(q => extracted.push({ question: q }));
        else if (values[0]) extracted.push({ question: values[0] });
      }
    }

    const deduped = dedupe(extracted);
    console.log(`[PARSER] Sheet '${sheetName}' — ${deduped.length} questions detected`);
    all.push(...deduped);
  }

  const final = dedupe(all);
  console.log(`[PARSER] Total: ${final.length} questions extracted from ${filename}`);
  return final;
}

async function fromDOCX(buf: Buffer): Promise<Q[]> {
  const res = await mammoth.extractRawText({ buffer: buf });
  const qs = extractQuestionsFromText(res.value);
  if (qs.length) return dedupe(qs.map(q => ({ question: q })));

  // If no '?' sentences, treat each non-empty line as a prompt-like item
  const lines = res.value.split(/\r?\n+/).map(norm).filter(Boolean);
  return dedupe(lines.map(l => ({ question: l })));
}

function fromTXT(buf: Buffer): Q[] {
  const text = buf.toString("utf8");
  const qs = extractQuestionsFromText(text);
  if (qs.length) return dedupe(qs.map(q => ({ question: q })));

  const lines = text.split(/\r?\n+/).map(norm).filter(Boolean);
  return dedupe(lines.map(l => ({ question: l })));
}

export async function parseUnified(buf: Buffer, filename: string): Promise<Q[]> {
  const lower = (filename || "").toLowerCase();

  try {
    if (lower.endsWith(".xlsx") || lower.endsWith(".xlsm") || lower.endsWith(".xls")) {
      return fromXLSX(buf, filename);
    }
    if (lower.endsWith(".csv")) {
      return fromCSV(buf);
    }
    if (lower.endsWith(".docx")) {
      return fromDOCX(buf);
    }
    if (lower.endsWith(".txt") || lower.endsWith(".md")) {
      return fromTXT(buf);
    }

    // Unknown: try text fallback
    return fromTXT(buf);
  } catch (err) {
    console.error("[PARSER_ERROR]", err);
    // Last-ditch: try text fallback so we return something
    return fromTXT(buf);
  }
}

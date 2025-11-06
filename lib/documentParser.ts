import { parse } from "csv-parse/sync";
import * as xlsx from "xlsx";

// ⚠️ pdf-parse uses test data that crashes on Vercel; sandbox it.
let pdfParse: any;
try {
  pdfParse = require("pdf-parse");
} catch {
  pdfParse = async () => ({ text: "" });
  console.warn("pdf-parse disabled in serverless environment");
}

export interface QAEntry { question: string; answer?: string; }

export async function parseFile(buffer: Buffer, name: string): Promise<QAEntry[]> {
  const lower = name.toLowerCase();
  if (lower.endsWith(".csv")) {
    const rows = parse(buffer.toString(), { columns: true, skip_empty_lines: true });
    return rows.map((r: any) => ({
      question: r.Q || r.Question || r.prompt || "",
      answer: r.A || r.Answer || r.response || "",
    })).filter(q => q.question?.trim());
  }
  if (lower.endsWith(".xlsx")) {
    const wb = xlsx.read(buffer, { type: "buffer" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = xlsx.utils.sheet_to_json(ws);
    return rows.map((r: any) => ({
      question: r.Q || r.Question || r.prompt || "",
      answer: r.A || r.Answer || r.response || "",
    })).filter(q => q.question?.trim());
  }
  if (lower.endsWith(".pdf")) {
    try {
      const data = await pdfParse(buffer);
      const lines = data.text.split("\n").filter(Boolean);
      return lines.map((line: string) => ({ question: line.trim(), answer: "" }));
    } catch (err) {
      console.error("PDF parse failed:", err);
      return [];
    }
  }
  return [];
}

import { Document, Packer, Paragraph, HeadingLevel, TextRun } from "docx";
import * as XLSX from "xlsx";
import type { QAItem } from "@/app/api/generate-report/route";

export interface Section {
  question: string;
  semanticMatches: { question: string; answers: string[]; score: number }[];
  fuzzyMatches: { question: string; answers: string[]; score: number }[];
  bestAnswer: { question: string; answer: string };
  finalAnswer: string;
  rawAnswers: { question: string; answer: string }[];
}

/* -------------------- Shared helpers -------------------- */

function norm(s: any) {
  return (s ?? "").toString().replace(/\s+/g, " ").trim();
}

// Match header names like "Question", "Alliant Question", "Prompt", etc.
const Q_HEADER_REGEX = /(question|prompt|rfp\s*item|inquiry|ask)/i;
// Match header names like "Answer", "Uprise Response", "Response", etc.
const A_HEADER_REGEX =
  /(answer|response|reply|details|description|explanation|ai\s*answer)/i;

/* -------------------- RFP DOCX report (unchanged) -------------------- */

export async function buildRfpReport(sections: Section[]): Promise<Buffer> {
  const doc = new Document({
    creator: "RFP AI Agent",
    description: "Generated RFP response report",
    title: "RFP Response",
    sections: [{ children: [] }],
  });
  const children: Paragraph[] = [];
  sections.forEach((section, idx) => {
    // Question heading
    children.push(
      new Paragraph({
        text: `${idx + 1}. ${section.question}`,
        heading: HeadingLevel.HEADING_2,
        spacing: { after: 200 },
      })
    );
    // Top semantic matches
    children.push(
      new Paragraph({
        text: "Top Semantic Matches:",
        heading: HeadingLevel.HEADING_3,
      })
    );
    section.semanticMatches.forEach((match, i) => {
      const preview =
        match.answers[0]?.split(/\n/).slice(0, 3).join("\n") || "";
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: `${i + 1}. Q: ${match.question}\n`,
              bold: true,
            }),
            new TextRun({ text: `A: ${preview}` }),
          ],
        })
      );
    });
    // Top fuzzy matches
    children.push(
      new Paragraph({
        text: "Top Fuzzy Matches:",
        heading: HeadingLevel.HEADING_3,
      })
    );
    section.fuzzyMatches.forEach((match, i) => {
      const preview =
        match.answers[0]?.split(/\n/).slice(0, 3).join("\n") || "";
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: `${i + 1}. Q: ${match.question}\n`,
              bold: true,
            }),
            new TextRun({ text: `A: ${preview}` }),
          ],
        })
      );
    });
    // AI-selected best existing answer
    children.push(
      new Paragraph({
        text: "Best Existing Answer:",
        heading: HeadingLevel.HEADING_3,
      })
    );
    children.push(
      new Paragraph({
        text: section.bestAnswer.answer,
        spacing: { after: 200 },
      })
    );
    // AI-synthesised final answer
    children.push(
      new Paragraph({
        text: "Synthesised Final Answer:",
        heading: HeadingLevel.HEADING_3,
      })
    );
    children.push(
      new Paragraph({
        text: section.finalAnswer,
        spacing: { after: 200 },
      })
    );
    // Raw answers (optional)
    children.push(
      new Paragraph({
        text: "Top Raw Answers:",
        heading: HeadingLevel.HEADING_3,
      })
    );
    section.rawAnswers.forEach((ra, i) => {
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: `${i + 1}. Q: ${ra.question}\n`,
              bold: true,
            }),
            new TextRun({ text: `A: ${ra.answer}` }),
          ],
        })
      );
    });
    // Add spacing between questions
    children.push(
      new Paragraph({
        text: "",
        spacing: { after: 400 },
      })
    );
  });
  (doc as any).Options.sections = [{ children }];
  const buffer = await Packer.toBuffer(doc);
  return buffer;
}

/* -------------------------------------------------------------
 * buildReplicaWorkbookFromXlsx
 *
 * IMPORTANT:
 * - Starts from the ORIGINAL uploaded workbook (originalBuffer)
 * - Preserves sheets, layout, and most formatting
 * - Fills an "answer" column in-place whenever we find a matching question
 * ----------------------------------------------------------- */

export async function buildReplicaWorkbookFromXlsx(
  items: QAItem[],
  originalFilename: string | undefined,
  originalBuffer: Buffer
): Promise<Buffer> {
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

    // Assume first row is header row (this matches how parseUnified treats it)
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

    // Fallbacks if headers are not labeled clearly:
    // - Treat FIRST column as the question column (like your MH RFI sheet)
    // - Treat NEXT column as the answer column, or same col if there is no next
    if (qCol === null) qCol = range.s.c;
    if (aCol === null) {
      aCol = qCol + 1 <= range.e.c ? qCol + 1 : qCol;
    }

    // 4) Update data rows (rows after headerRow)
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
  const buf = XLSX.write(wb, { bookType: "xlsx", type: "buffer" }) as Buffer;
  return Buffer.from(buf);
}

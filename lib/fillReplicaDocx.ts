import { Document, Packer, Paragraph, TextRun } from "docx";
import type { QAItem } from "@/app/api/generate-report/route";

/**
 * Simple DOCX sanitizer:
 * - strip control characters
 * - strip unpaired surrogate code units
 * - NO redaction / name stripping
 */
function sanitizeForDocx(input: any): string {
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

/**
 * buildReplicaDocx
 * Goal: as close to the original "questions-only" DOCX as we can get,
 * with the ONLY structural change being that we add an answer line
 * directly after each question.
 *
 * Layout:
 *   Question text (exact text from the parsed document)
 *   Answer: <AI answer>
 *   [blank line]
 */
export async function buildReplicaDocx(
  items: QAItem[],
  _originalFilename?: string
): Promise<Buffer> {
  const children: Paragraph[] = [];

  for (const item of items) {
    const q = sanitizeForDocx(item.question);
    const a = sanitizeForDocx(
      item.aiAnswer || "Information not found in KB."
    );

    if (!q) {
      continue;
    }

    // Question paragraph - plain text, no heading, no extra styling.
    // This preserves numbering like "3. How does the vendor..." exactly.
    children.push(
      new Paragraph({
        children: [new TextRun({ text: q })],
      })
    );

    // Answer paragraph directly below it.
    children.push(
      new Paragraph({
        children: [
          new TextRun({ text: "Answer: ", bold: true }),
          new TextRun({ text: a }),
        ],
      })
    );

    // Blank line between Q&A blocks
    children.push(new Paragraph({ text: "" }));
  }

  const doc = new Document({
    sections: [
      {
        children,
      },
    ],
  });

  const buf = await Packer.toBuffer(doc);
  return Buffer.from(buf);
}

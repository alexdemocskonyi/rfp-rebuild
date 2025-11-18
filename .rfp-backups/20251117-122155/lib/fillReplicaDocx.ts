//lib/buildSimpleDocx.ts

import {
  Document,
  Packer,
  Paragraph,
  TextRun,
} from "docx";
import type { QAItem } from "@/app/api/generate-report/route";

function sanitizeForDocx(input: any): string {
  const s = (input ?? "").toString();
  let out = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
  out = out.replace(/([\uD800-\uDBFF])(?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])([\uDC00-\uDFFF])/g, "");
  return out.trim();
}

export async function buildReplicaDocx(
  items: QAItem[],
  originalFilename?: string
): Promise<Buffer> {
  const paras: Paragraph[] = [];

  const title = originalFilename
    ? `Filled RFP – ${originalFilename}`
    : "Filled RFP";

  paras.push(new Paragraph(title));
  paras.push(new Paragraph(""));

  items.forEach((item) => {
    const q = sanitizeForDocx(item.question);
    const a = sanitizeForDocx(item.aiAnswer || "Information not found in KB.");

    paras.push(
      new Paragraph({
        children: [new TextRun({ text: q, bold: true })],
      })
    );

    paras.push(
      new Paragraph({
        children: [
          new TextRun({ text: "Answer: ", bold: true }),
          new TextRun(a),
        ],
      })
    );

    paras.push(new Paragraph(""));
  });

  const doc = new Document({ sections: [{ children: paras }] });
  const buf = await Packer.toBuffer(doc);
  return Buffer.from(buf);
}

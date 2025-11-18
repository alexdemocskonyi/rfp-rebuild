import {
  Document,
  Packer,
  Paragraph,
  HeadingLevel,
  TextRun,
} from "docx";

// Type-only import, erased at runtime – no circular dependency
import type { QAItem } from "@/app/api/generate-report/route";

/**
 * Local sanitizer (NO name redaction)
 * We only strip control characters and invalid surrogates,
 * same behavior as your Simple/Replica docs.
 */

function sanitizeForDocxLocal(input: any): string {
  let s = (input ?? "").toString();

  // strip control chars
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");

  // remove unpaired surrogates
  s = s.replace(
    /([\uD800-\uDBFF])(?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])([\uDC00-\uDFFF])/g,
    ""
  );

  // IMPORTANT: no personal name stripping here.
  return s.trim();
}

// helper: dedupe and limit sources
function getCleanSources(sources?: string[]): string[] {
  if (!sources || !sources.length) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of sources) {
    const s = sanitizeForDocxLocal(raw);
    const key = s.toLowerCase();
    if (!s || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= 8) break;
  }
  return out;
}

export async function buildAnalystDocx(
  items: QAItem[],
  originalFilename?: string
): Promise<Buffer> {
  const paras: Paragraph[] = [];

  // ASCII-only to avoid unicode parse issues
  const title = originalFilename
    ? "RFP Analyst Report - " + sanitizeForDocxLocal(originalFilename)
    : "RFP Analyst Report";

  // Title
  paras.push(
    new Paragraph({
      text: title,
      heading: HeadingLevel.TITLE,
    })
  );

  // Spacer
  paras.push(new Paragraph({ text: "" }));

  items.forEach((item, idx) => {
    const q = sanitizeForDocxLocal(item.question);
    const a = sanitizeForDocxLocal(
      item.aiAnswer || "Information not found in KB."
    );

    const sources = getCleanSources(item.sourcesUsed);
    const hasContextual = !!item.contextualMatches?.length;
    const hasRawText = !!item.rawTextMatches?.length;

    // Question heading
    paras.push(
      new Paragraph({
        text: "Question " + (idx + 1) + ": " + q,
        heading: HeadingLevel.HEADING_2,
      })
    );

    // Answer
    paras.push(
      new Paragraph({
        children: [
          new TextRun({ text: "Answer:\n", bold: true }),
          new TextRun(a),
        ],
      })
    );

    // Sources used
    if (sources.length) {
      paras.push(
        new Paragraph({
          children: [new TextRun({ text: "Sources used:", bold: true })],
        })
      );

      sources.forEach((src) => {
        paras.push(
          new Paragraph({
            bullet: { level: 0 },
            children: [new TextRun(src)],
          })
        );
      });
    }

    // Top contextual match
    if (hasContextual) {
      const m = item.contextualMatches![0];
      paras.push(
        new Paragraph({
          children: [new TextRun({ text: "Top contextual match:", bold: true })],
        })
      );
      paras.push(
        new Paragraph({
          bullet: { level: 0 },
          children: [
            new TextRun({
              text: "[" + sanitizeForDocxLocal(m.source) + "] ",
              bold: true,
            }),
            new TextRun(sanitizeForDocxLocal(m.snippet)),
          ],
        })
      );
    }

    // Top raw-text match
    if (hasRawText) {
      const m = item.rawTextMatches![0];
      paras.push(
        new Paragraph({
          children: [new TextRun({ text: "Top raw-text match:", bold: true })],
        })
      );
      paras.push(
        new Paragraph({
          bullet: { level: 0 },
          children: [
            new TextRun({
              text: "[" + sanitizeForDocxLocal(m.source) + "] ",
              bold: true,
            }),
            new TextRun(sanitizeForDocxLocal(m.snippet)),
          ],
        })
      );
    }

    // Spacer between questions
    paras.push(new Paragraph({ text: "" }));
  });

  const doc = new Document({
    sections: [{ children: paras }],
  });

  const buf = await Packer.toBuffer(doc);
  return Buffer.from(buf);
}

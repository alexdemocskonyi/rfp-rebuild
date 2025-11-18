import * as XLSX from "xlsx";
import type { QAItem } from "@/app/api/generate-report/route";

function norm(s: any) {
  return (s ?? "").toString().replace(/\s+/g, " ").trim();
}

export async function buildXlsxReport(
  items: QAItem[],
  originalFilename?: string
): Promise<Buffer> {
  const wb = XLSX.utils.book_new();

  const header = [
    "Question #",
    "Question",
    "AI Answer",
    "Sources Used",
    "Top Contextual Source",
    "Top Contextual Snippet",
    "Top Raw-text Source",
    "Top Raw-text Snippet",
  ];

  const rows = items.map((item, idx) => {
    const cm = item.contextualMatches?.[0];
    const rm = item.rawTextMatches?.[0];
    return [
      idx + 1,
      norm(item.question),
      norm(item.aiAnswer || "Information not found in KB."),
      norm(item.sourcesUsed?.join("; ") || ""),
      cm ? norm(cm.source) : "",
      cm ? norm(cm.snippet) : "",
      rm ? norm(rm.source) : "",
      rm ? norm(rm.snippet) : "",
    ];
  });

  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  XLSX.utils.book_append_sheet(wb, ws, "Q&A");

  const buf = XLSX.write(wb, { bookType: "xlsx", type: "buffer" }) as Buffer;
  return Buffer.from(buf);
}

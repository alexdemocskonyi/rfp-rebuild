"use client";

import { useState } from "react";
import ChatWidget from "@/components/ChatWidget";
import {
  Document,
  Packer,
  Paragraph,
  HeadingLevel,
  TextRun,
} from "docx";

type MatchItem = {
  source: string;
  snippet: string;
};

type QAItem = {
  question: string;
  aiAnswer: string;
  sourcesUsed?: string[];
  contextualMatches?: MatchItem[];
  rawTextMatches?: MatchItem[];
};

export default function HomePage() {
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  // Unified ingest helper
  async function ingestFile() {
    if (!file) {
      setStatus("Please select a file first.");
      return false;
    }

    setStatus("📤 Uploading and ingesting file...");
    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch("/api/ingest", {
        method: "POST",
        body: formData,
      });
      const json = await res.json();

      if (!res.ok) {
        setStatus(`❌ Ingest error: ${json.error || "Server failure"}`);
        return false;
      }

      if (json.ok) {
        if (json.skipped) {
          setStatus(
            `⚠️ ${json.reason || "No KB update, but ready to generate report."}`
          );
        } else {
          setStatus(
            `✅ Ingested ${json.total || "some"} entries into Knowledge Base.`
          );
        }
        return true;
      }

      if (json.reason) {
        setStatus(`⚠️ ${json.reason}`);
        return true;
      }

      setStatus("❌ Ingest error: Unknown ingest failure");
      return false;
    } catch (err: any) {
      setStatus(`❌ Ingest exception: ${err.message}`);
      return false;
    }
  }

  async function handleGenerate() {
    if (!file) {
      setStatus("Please select a file first.");
      return;
    }

    setLoading(true);
    setStatus("⚙️ Ingesting before report generation…");

    const ok = await ingestFile();
    if (!ok) {
      setLoading(false);
      return;
    }

    try {
      setStatus("🧠 Generating RFP report (this may take a few minutes)…");

      const allItems: QAItem[] = [];
      let batch = 0;
      let totalQuestions = 0;

      // 🔁 Loop over server-side batches until done
      while (true) {
        const form = new FormData();
        form.append("file", file);
        form.append("batch", String(batch));

        const res = await fetch("/api/generate-report", {
          method: "POST",
          body: form,
        });

        const json = await res.json();

        if (!res.ok || !json.ok) {
          const msg = json?.error || `HTTP ${res.status}`;
          throw new Error(msg);
        }

        const items: QAItem[] = json.items || [];
        totalQuestions = json.totalQuestions || totalQuestions;

        allItems.push(...items);

        const done: boolean = !!json.done;
        setStatus(
          `🧠 Generating RFP report… (${allItems.length}/${totalQuestions} questions processed)`
        );

        if (done) break;
        batch += 1;
      }

      // --- Build one DOCX on the client ---
      const paras: Paragraph[] = [];

      allItems.forEach((item, idx) => {
        // Question heading
        paras.push(
          new Paragraph({
            text: `Question ${idx + 1}: ${item.question}`,
            heading: HeadingLevel.HEADING_2,
          })
        );

        // AI Answer
        paras.push(
          new Paragraph({
            children: [
              new TextRun({ text: "Answer:\n", bold: true }),
              new TextRun(item.aiAnswer || "Information not found in KB."),
            ],
          })
        );

        // Sources used
        if (item.sourcesUsed && item.sourcesUsed.length > 0) {
          paras.push(
            new Paragraph({
              children: [
                new TextRun({ text: "Sources used: ", bold: true }),
                new TextRun(item.sourcesUsed.join("; ")),
              ],
            })
          );
        }

        // Top contextual matches (KB answers)
        if (item.contextualMatches && item.contextualMatches.length > 0) {
          paras.push(
            new Paragraph({
              children: [new TextRun({ text: "Top contextual matches:", bold: true })],
            })
          );

          item.contextualMatches.forEach((m) => {
            paras.push(
              new Paragraph({
                bullet: { level: 0 },
                children: [
                  new TextRun({
                    text: `[${m.source}] `,
                    bold: true,
                  }),
                  new TextRun(m.snippet),
                ],
              })
            );
          });
        }

        // Top raw-text matches
        if (item.rawTextMatches && item.rawTextMatches.length > 0) {
          paras.push(
            new Paragraph({
              children: [new TextRun({ text: "Top raw-text matches:", bold: true })],
            })
          );

          item.rawTextMatches.forEach((m) => {
            paras.push(
              new Paragraph({
                bullet: { level: 0 },
                children: [
                  new TextRun({
                    text: `[${m.source}] `,
                    bold: true,
                  }),
                  new TextRun(m.snippet),
                ],
              })
            );
          });
        }

        // Spacer
        paras.push(new Paragraph({ text: "" }));
      });

      const doc = new Document({
        sections: [{ children: paras }],
      });

      const blob = await Packer.toBlob(doc);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `RFP_Report_${Date.now()}.docx`;
      a.click();
      URL.revokeObjectURL(url);

      setStatus("✅ Report generated successfully.");
    } catch (err: any) {
      console.error("Report generation failed", err);
      setStatus(
        `❌ Report generation failed: ${err.message || "Unknown error"}`
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <main
      style={{
        display: "flex",
        flexDirection: "row",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "60px 20px",
        minHeight: "100vh",
        background: "#f8f9fa",
        gap: "40px",
      }}
    >
      <div style={{ maxWidth: 420, textAlign: "center" }}>
        <h1 style={{ fontSize: "1.8rem", fontWeight: 700 }}>
          📄 UPRISE RFP Tool
        </h1>
        <p style={{ color: "#555", marginBottom: "1rem" }}>
          Upload a document — we’ll ingest it automatically before generating
          your report.
        </p>

        <input
          type="file"
          onChange={(e) => setFile(e.target.files?.[0] || null)}
          style={{
            border: "1px solid #ccc",
            borderRadius: "6px",
            padding: "8px",
            background: "#fff",
            width: "100%",
          }}
        />

        <div
          style={{
            display: "flex",
            gap: "10px",
            marginTop: "15px",
            justifyContent: "center",
          }}
        >
          <button
            onClick={ingestFile}
            disabled={loading || !file}
            style={{
              background: "#28a745",
              color: "#fff",
              border: "none",
              padding: "10px 18px",
              borderRadius: "6px",
              cursor: loading ? "wait" : "pointer",
              fontWeight: 600,
            }}
          >
            Ingest to Knowledge Base
          </button>

          <button
            onClick={handleGenerate}
            disabled={loading || !file}
            style={{
              background: "#007bff",
              color: "#fff",
              border: "none",
              padding: "10px 18px",
              borderRadius: "6px",
              cursor: loading ? "wait" : "pointer",
              fontWeight: 600,
            }}
          >
            {loading ? "Processing..." : "Generate RFP Report"}
          </button>
        </div>

        {status && (
          <div
            style={{
              marginTop: "20px",
              background: "#fff",
              padding: "10px 20px",
              borderRadius: "6px",
              boxShadow: "0 1px 4px rgba(0,0,0,0.1)",
              color: status.startsWith("❌")
                ? "red"
                : status.startsWith("⚠️")
                ? "#b58900"
                : "green",
              minHeight: "50px",
              whiteSpace: "pre-line",
              fontWeight: 500,
            }}
          >
            {status}
          </div>
        )}
      </div>

      <div
        style={{
          width: "400px",
          maxHeight: "600px",
          background: "#fff",
          borderRadius: "12px",
          boxShadow: "0 2px 10px rgba(0,0,0,0.1)",
          overflow: "hidden",
          flexShrink: 0,
        }}
      >
        <ChatWidget />
      </div>
    </main>
  );
}

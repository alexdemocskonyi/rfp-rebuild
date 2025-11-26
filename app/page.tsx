// page.tsx

"use client";

import { useState } from "react";
import ChatWidget from "@/components/ChatWidget";

// Download helper
function downloadZip(payload: any) {
  if (!payload || !payload.data) return;
  const bytes = Uint8Array.from(atob(payload.data), (c) => c.charCodeAt(0));
  const blob = new Blob([bytes], { type: payload.mime || "application/zip" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = payload.filename || "reports.zip";
  a.click();
  URL.revokeObjectURL(url);
}

export default function HomePage() {
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");

  async function ingestFile() {
    if (!file) {
      setStatus("Please select a file first.");
      return false;
    }

    setStatus("📤 Uploading & ingesting file…");
    const form = new FormData();
    form.append("file", file);

    try {
      const res = await fetch("/api/ingest", { method: "POST", body: form });
      const json = await res.json();

      if (!json.ok) {
        setStatus(`⚠️ ${json.error || json.reason}`);
        return false;
      }

      setStatus("✅ File ingested successfully.");
      return true;
    } catch (err: any) {
      setStatus(`❌ Ingest failed: ${err.message}`);
      return false;
    }
  }

  async function handleGenerate() {
    if (!file) {
      setStatus("Please select a file first.");
      return;
    }

    setLoading(true);
    setStatus("⚙️ Ingesting…");

    if (!(await ingestFile())) {
      setLoading(false);
      return;
    }

    try {
      setStatus("🧠 Generating all report formats…");

      const form = new FormData();
      form.append("file", file);

      const res = await fetch("/api/generate-report", {
        method: "POST",
        body: form,
      });

      const json = await res.json();

      if (!json.ok) throw new Error(json.error || "Report generation failed");

      downloadZip(json.zip);

      setStatus(
        `✅ Generated ${json.totalQuestions} questions. ZIP downloaded successfully.`
      );
    } catch (err: any) {
      setStatus(`❌ ${err.message}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main
      style={{
        display: "flex",
        flexDirection: "row",
        justifyContent: "center",
        padding: "60px 20px",
        gap: "40px",
        background: "#f8f9fa",
        minHeight: "100vh",
      }}
    >
      <div style={{ maxWidth: 420, textAlign: "center" }}>
        <h1 style={{ fontSize: "1.8rem", fontWeight: 700 }}>
          📄 UPRISE RFP Tool
        </h1>

        <input
          type="file"
          onChange={(e) => setFile(e.target.files?.[0] || null)}
          style={{
            border: "1px solid #ccc",
            padding: "8px",
            borderRadius: "6px",
            background: "#fff",
            width: "100%",
          }}
        />

        <div
          style={{
            display: "flex",
            gap: "10px",
            marginTop: 15,
            justifyContent: "center",
          }}
        >
          <button
            onClick={ingestFile}
            disabled={!file || loading}
            style={{
              background: "#28a745",
              padding: "10px 18px",
              borderRadius: "6px",
              color: "white",
            }}
          >
            Ingest
          </button>

          <button
            onClick={handleGenerate}
            disabled={!file || loading}
            style={{
              background: "#007bff",
              padding: "10px 18px",
              borderRadius: "6px",
              color: "white",
            }}
          >
            {loading ? "Processing…" : "Generate All Reports (ZIP)"}
          </button>
        </div>

        {status && (
          <div
            style={{
              marginTop: 20,
              padding: "12px 20px",
              borderRadius: "6px",
              background: "#fff",
              boxShadow: "0 1px 4px rgba(0,0,0,0.1)",
              fontWeight: 500,
              whiteSpace: "pre-wrap",
              color:
                status.startsWith("❌")
                  ? "red"
                  : status.startsWith("⚠️")
                  ? "#b58900"
                  : "green",
            }}
          >
            {status}
          </div>
        )}
      </div>

      <div
        style={{
          width: 400,
          maxHeight: 600,
          background: "white",
          borderRadius: 12,
          boxShadow: "0 2px 10px rgba(0,0,0,0.1)",
          overflow: "hidden",
        }}
      >
        <ChatWidget />
      </div>
    </main>
  );
}

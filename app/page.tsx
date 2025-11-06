"use client";
import { useState } from "react";
import ChatWidget from "@/components/ChatWidget";

export default function HomePage() {
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  async function ingestFile() {
    if (!file) {
      setStatus("Please select a file first.");
      return false;
    }
    const formData = new FormData();
    formData.append("file", file);
    setStatus("📤 Uploading and ingesting file...");

    try {
      const res = await fetch("/api/ingest", { method: "POST", body: formData });
      const json = await res.json();
      if (json.ok) {
        setStatus(`✅ Ingested ${json.total || "some"} entries into Knowledge Base.`);
        return true;
      }
      if (json.skipped) {
        setStatus(`⚠️ Skipped ingest — ${json.reason}`);
        return true; // allow generation anyway
      }
      throw new Error(json.error || "Unknown ingest failure");
    } catch (err: any) {
      setStatus(`❌ Ingest error: ${err.message}`);
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

    setStatus("🧠 Generating RFP Report...");
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/generate-report", { method: "POST", body: form });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `RFP_Report_${Date.now()}.docx`;
      a.click();
      URL.revokeObjectURL(url);
      setStatus("✅ Report generated successfully.");
    } catch (err: any) {
      setStatus(`❌ Report generation failed: ${err.message}`);
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
        <h1 style={{ fontSize: "1.8rem", fontWeight: 700 }}>📄 UPRISE RFP Tool</h1>
        <p style={{ color: "#555", marginBottom: "1rem" }}>
          Upload a document — we’ll ingest it automatically before generating your report.
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

        <div style={{ display: "flex", gap: "10px", marginTop: "15px", justifyContent: "center" }}>
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
              color: status.startsWith("❌") ? "red" : "#333",
              minHeight: "50px",
              whiteSpace: "pre-line",
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

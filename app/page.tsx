"use client";
import React from "react";

export default function HomePage() {
  const handleUpload = async () => {
    const input = document.querySelector("input[type=file]") as HTMLInputElement | null;
    if (!input || !input.files?.length) {
      alert("Please select a file first.");
      return;
    }
    const file = input.files[0];
    const formData = new FormData();
    formData.append("file", file); // 👈 exact key matches backend

    const res = await fetch("/api/ingest", { method: "POST", body: formData });
    const data = await res.json();
    console.log("Server response:", data);
    alert(JSON.stringify(data, null, 2));
  };

  return (
    <div style={{ padding: 40 }}>
      <h1>RFP AI Agent</h1>
      <p>
        Upload knowledge base documents, chat with your questions and generate
        filled RFP reports.
      </p>
      <h2>1. Ingest Knowledge Base</h2>
      <input type="file" name="file" />
      <button onClick={handleUpload}>Upload and Ingest</button>
    </div>
  );
}

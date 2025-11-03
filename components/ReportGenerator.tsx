"use client";

import React, { useState } from 'react';

export default function ReportGenerator() {
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setLoading(true);
    setError(null);
    setDownloadUrl(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch('/api/generate-report', {
        method: 'POST',
        body: formData,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || 'Failed to generate report');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      setDownloadUrl(url);
    } catch (err: any) {
      console.error(err);
      setError(err.message || 'An unknown error occurred');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="bg-white p-4 border rounded-md shadow-sm">
      <form onSubmit={handleSubmit} className="space-y-4">
        <input
          type="file"
          accept=".pdf,.docx,.csv,.xlsx,.xls"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
          }}
          className="block w-full text-sm text-gray-900 border border-gray-300 rounded-md cursor-pointer focus:outline-none"
        />
        <button
          type="submit"
          disabled={loading || !file}
          className="px-4 py-2 bg-blue-600 text-white rounded-md disabled:bg-gray-400"
        >
          {loading ? 'Generating...' : 'Generate Report'}
        </button>
      </form>
      {error && <p className="text-red-600 mt-2">{error}</p>}
      {downloadUrl && (
        <div className="mt-4">
          <a
            href={downloadUrl}
            download="report.docx"
            className="text-blue-600 underline"
          >
            Download Generated RFP Report
          </a>
        </div>
      )}
    </div>
  );
}
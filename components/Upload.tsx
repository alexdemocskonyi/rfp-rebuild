"use client";

import React, { useState } from 'react';

interface IngestResponse {
  summary: string;
  count: number;
  inserted: number;
  updated: number;
  errors: string[];
}

export default function Upload() {
  const [files, setFiles] = useState<FileList | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<IngestResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!files || files.length === 0) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const formData = new FormData();
      Array.from(files).forEach((file) => {
        formData.append('files', file);
      });
      const res = await fetch('/api/ingest', {
        method: 'POST',
        body: formData,
      });
      if (!res.ok) {
        const message = await res.text();
        throw new Error(message || 'Failed to ingest files');
      }
      const json = await res.json();
      setResult(json);
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
          multiple
          accept=".csv,.xlsx,.xls,.docx,.pdf"
          onChange={(e) => setFiles(e.target.files)}
          className="block w-full text-sm text-gray-900 border border-gray-300 rounded-md cursor-pointer focus:outline-none"
        />
        <button
          type="submit"
          disabled={loading || !files || files.length === 0}
          className="px-4 py-2 bg-blue-600 text-white rounded-md disabled:bg-gray-400"
        >
          {loading ? 'Uploading...' : 'Upload and Ingest'}
        </button>
      </form>
      {error && (
        <p className="text-red-600 mt-2">{error}</p>
      )}
      {result && (
        <div className="mt-4 text-sm text-gray-700 whitespace-pre-wrap">
          <p><strong>Summary:</strong> {result.summary}</p>
          <p>Items processed: {result.count}</p>
          <p>Inserted: {result.inserted}</p>
          <p>Updated: {result.updated}</p>
          {result.errors.length > 0 && (
            <div className="mt-2">
              <p><strong>Errors:</strong></p>
              <ul className="list-disc list-inside">
                {result.errors.map((err, idx) => (
                  <li key={idx}>{err}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
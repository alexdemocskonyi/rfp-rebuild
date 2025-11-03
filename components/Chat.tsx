"use client";

import React, { useState } from 'react';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface KBMatch {
  question: string;
  answers: string[];
  score: number;
}

export default function Chat() {
  const [query, setQuery] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!query || query.trim().length < 1) return;
    const trimmed = query.trim();
    setMessages((prev) => [...prev, { role: 'user', content: trimmed }]);
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: trimmed }),
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(txt || 'Error querying knowledge base');
      }
      const data = await res.json();
      const answer = formatMatches(data.matches);
      setMessages((prev) => [...prev, { role: 'assistant', content: answer }]);
    } catch (err: any) {
      console.error(err);
      setError(err.message || 'An unknown error occurred');
    } finally {
      setLoading(false);
      setQuery('');
    }
  }

  function formatMatches(matches: KBMatch[]): string {
    if (!matches || matches.length === 0) return 'No matching entries found.';
    return matches
      .map((m) => {
        const preview = m.answers[0]?.split(/\n/).slice(0, 3).join('\n') || 'No answer available.';
        return `Q: ${m.question}\nA: ${preview}`;
      })
      .join('\n\n');
  }

  return (
    <div className="bg-white p-4 border rounded-md shadow-sm">
      <div className="space-y-2 mb-4 max-h-96 overflow-y-auto">
        {messages.map((msg, idx) => (
          <div key={idx} className={msg.role === 'user' ? 'text-right' : 'text-left'}>
            <p className={msg.role === 'user' ? 'text-blue-700' : 'text-green-700'}>
              <strong>{msg.role === 'user' ? 'You' : 'Agent'}:</strong> {msg.content}
            </p>
          </div>
        ))}
        {loading && (
          <p className="text-gray-500">Thinking...</p>
        )}
      </div>
      <form onSubmit={handleSubmit} className="flex space-x-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Type your question..."
          className="flex-grow px-3 py-2 border rounded-md"
        />
        <button
          type="submit"
          disabled={loading || query.trim().length === 0}
          className="px-4 py-2 bg-blue-600 text-white rounded-md disabled:bg-gray-400"
        >
          Send
        </button>
      </form>
      {error && <p className="text-red-600 mt-2">{error}</p>}
    </div>
  );
}
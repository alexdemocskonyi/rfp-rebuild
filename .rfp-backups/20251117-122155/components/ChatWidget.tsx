//ChatWidget.ts

"use client";

import React, { useEffect, useRef, useState } from "react";

type Msg = { role: "user" | "assistant"; content: string };

export default function ChatWidget() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, open]);

  async function sendMessage(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;

    const nextMsgs: Msg[] = [...messages, { role: "user", content: text }];
    setMessages(nextMsgs);
    setInput("");
    setBusy(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // send the whole conversation so the API has context
          messages: nextMsgs,
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(errText || "Chat request failed");
      }

      const data = await res.json();

      // /api/chat returns { ok: true, content }
      const reply =
        data.content ||
        data.answer ||
        data.message ||
        data.error ||
        "⚠️ No response received from assistant.";

      setMessages((prev) => [...prev, { role: "assistant", content: reply }]);
    } catch (err: any) {
      console.error("CHAT_WIDGET_ERROR", err);
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: `❌ Error: ${err.message || "Unable to reach assistant."}`,
        },
      ]);
    } finally {
      setBusy(false);
    }
  }

  async function saveToKB() {
    if (saving) return;

    let lastUser: Msg | undefined;
    let lastAssistant: Msg | undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (!lastAssistant && messages[i].role === "assistant")
        lastAssistant = messages[i];
      else if (!lastUser && messages[i].role === "user")
        lastUser = messages[i];
      if (lastUser && lastAssistant) break;
    }

    if (!lastUser || !lastAssistant) {
      alert("No Q&A pair to save.");
      return;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/kb-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: lastUser.content,
          answer: lastAssistant.content,
          source: "chat-manual",
        }),
      });

      const data = await res.json();
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: data?.ok
            ? "✅ Added to Knowledge Base."
            : `❌ Save failed: ${data?.error || "Unknown error"}`,
        },
      ]);
    } catch (e: any) {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: `❌ Save failed: ${e?.message || "Network error"}`,
        },
      ]);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      {/* Floating Toggle */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="fixed bottom-6 right-6 bg-blue-600 hover:bg-blue-700 text-white rounded-full shadow-lg w-14 h-14 flex items-center justify-center text-2xl z-[9999]"
        title={open ? "Close chat" : "Chat with Uprise Assistant"}
        aria-label="Chat"
        type="button"
      >
        💬
      </button>

      {open && (
        <div className="fixed bottom-[90px] right-6 z-[9999] w-[360px] sm:w-[380px] bg-white border border-gray-200 rounded-xl shadow-2xl flex flex-col overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between bg-blue-600 text-white px-4 py-2">
            <h2 className="text-sm font-semibold">Uprise Chat Assistant</h2>
            <button
              onClick={() => setOpen(false)}
              className="text-white hover:text-gray-100 text-xl leading-none"
              aria-label="Close chat"
              type="button"
            >
              ×
            </button>
          </div>

          {/* Messages */}
          <div
            className="flex-1 overflow-y-auto px-3 py-2 space-y-2 scrollbar-thin scrollbar-thumb-gray-300 scrollbar-track-transparent"
            style={{
              maxHeight: "60vh",
              overflowY: "auto",
              wordBreak: "break-word",
              whiteSpace: "pre-wrap",
            }}
          >
            {messages.length === 0 && (
              <div className="text-gray-500 text-sm text-center mt-4">
                👋 Hi! How can I help with your RFP today?
              </div>
            )}
            {messages.map((m, i) => (
              <div
                key={i}
                className={`p-2 rounded-lg text-sm ${
                  m.role === "user"
                    ? "bg-blue-50 text-right border border-blue-100"
                    : "bg-gray-50 text-left border border-gray-100"
                }`}
                style={{
                  maxWidth: "100%",
                  overflowWrap: "break-word",
                }}
              >
                {m.content}
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>

          {/* Save-to-KB */}
          {messages.some((m) => m.role === "assistant") && (
            <button
              onClick={saveToKB}
              disabled={saving}
              className="mx-3 mb-2 bg-green-600 hover:bg-green-700 text-white text-sm rounded-lg py-1.5 px-3 transition disabled:opacity-50"
              type="button"
            >
              {saving ? "Saving..." : "💾 Save to Knowledge Base"}
            </button>
          )}

          {/* Input */}
          <form onSubmit={sendMessage} className="flex border-t border-gray-200">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={busy ? "Thinking..." : "Type your question or command..."}
              disabled={busy}
              className="flex-1 p-2 text-sm focus:outline-none"
            />
            <button
              type="submit"
              disabled={busy}
              className="px-4 py-2 bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
            >
              Send
            </button>
          </form>
        </div>
      )}
    </>
  );
}

"use client";

import { useState, useRef, useEffect } from "react";

export default function ChatWidget() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<{ role: "user" | "assistant"; content: string }[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const messagesEnd = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (messagesEnd.current) messagesEnd.current.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function sendMessage(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || busy) return;

    const newMsgs = [...messages, { role: "user", content: input.trim() }];
    setMessages(newMsgs);
    setInput("");
    setBusy(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: newMsgs }),
      });
      const data = await res.json();
      const reply = data.reply || "No response.";
      setMessages((prev) => [...prev, { role: "assistant", content: reply }]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "⚠️ Error: Unable to reach chat service." },
      ]);
    } finally {
      setBusy(false);
    }
  }

  async function saveToKB() {
    const lastUser = messages.findLast((m) => m.role === "user");
    const lastAssistant = messages.findLast((m) => m.role === "assistant");

    if (!lastUser || !lastAssistant) return alert("No Q&A pair to save.");

    setSaving(true);
    try {
      const res = await fetch("/api/kb-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: lastUser.content,
          answer: lastAssistant.content,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: `✅ Added to Knowledge Base (total entries: ${data.count}).`,
          },
        ]);
      } else throw new Error(data.error || "Save failed");
    } catch (err: any) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `❌ Error saving: ${err.message}` },
      ]);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      {/* Floating Chat Toggle Button */}
      <button
        onClick={() => setOpen(!open)}
        className="fixed bottom-6 right-6 bg-blue-600 hover:bg-blue-700 text-white rounded-full shadow-lg w-14 h-14 flex items-center justify-center text-2xl transition-all z-[9999]"
        style={{
          fontWeight: "bold",
          position: "fixed",
        }}
        title={open ? "Close chat" : "Chat with Uprise Assistant"}
      >
        💬
      </button>

      {/* Chat Window */}
      {open && (
        <div
          className="fixed bottom-[90px] right-6 z-[9999] w-[360px] sm:w-[380px] bg-white border border-gray-200 rounded-xl shadow-2xl flex flex-col overflow-hidden"
          style={{
            maxHeight: "70vh",
            position: "fixed",
          }}
        >
          {/* Header */}
          <div className="flex items-center justify-between bg-blue-600 text-white px-4 py-2">
            <h2 className="text-sm font-semibold">Uprise Chat Assistant</h2>
            <button
              onClick={() => setOpen(false)}
              className="text-white hover:text-gray-100 text-xl leading-none"
            >
              ×
            </button>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2" style={{ maxHeight: "50vh" }}>
            {messages.length === 0 && (
              <div className="text-gray-500 text-sm text-center mt-4">
                👋 Hi! How can I help with your RFP?
              </div>
            )}
            {messages.map((m, i) => (
              <div
                key={i}
                className={`p-2 rounded-lg text-sm whitespace-pre-wrap ${
                  m.role === "user"
                    ? "bg-blue-50 text-right border border-blue-100"
                    : "bg-gray-50 text-left border border-gray-100"
                }`}
              >
                {m.content}
              </div>
            ))}
            <div ref={messagesEnd} />
          </div>

          {/* Save to KB Button */}
          {messages.some((m) => m.role === "assistant") && (
            <button
              onClick={saveToKB}
              disabled={saving}
              className="mx-3 mb-2 bg-green-600 hover:bg-green-700 text-white text-sm rounded-lg py-1.5 px-3 transition disabled:opacity-50"
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
              placeholder={busy ? "Thinking..." : "Type your message..."}
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

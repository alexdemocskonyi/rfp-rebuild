//ChatWidget.tsx

"use client";

import React, { useState } from "react";

type ChatMessageRole = "user" | "assistant" | "system" | "error";

interface ChatMessage {
  role: ChatMessageRole;
  content: string;
}

interface ChatApiResponse {
  ok: boolean;
  question?: string;
  aiAnswer?: string;
  message?: {
    role: string;
    content: string;
  };
  error?: string;
  rawMatches?: any[];
}

/**
 * Super-defensive ChatWidget:
 * - Never throws on bad responses
 * - Shows errors as messages instead of crashing the app
 */
export default function ChatWidget() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  const lastUserMessage = messages
    .slice()
    .reverse()
    .find((m) => m.role === "user");
  const lastAssistantMessage = messages
    .slice()
    .reverse()
    .find((m) => m.role === "assistant");

  async function handleSend() {
    const question = input.trim();
    if (!question) {
      // show inline error but do NOT call API
      setMessages((prev) => [
        ...prev,
        {
          role: "error",
          content: "Please type a question before sending.",
        },
      ]);
      return;
    }

    // Push the user message immediately
    setMessages((prev) => [
      ...prev,
      { role: "user", content: question },
    ]);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ question }),
      });

      let data: ChatApiResponse | null = null;

      try {
        data = (await res.json()) as ChatApiResponse;
      } catch (jsonErr) {
        console.error("[CHAT] Failed to parse JSON from /api/chat", jsonErr);
        setMessages((prev) => [
          ...prev,
          {
            role: "error",
            content:
              "Chat API returned an invalid response. Please try again or refresh.",
          },
        ]);
        return;
      }

      if (!res.ok || !data || data.ok === false) {
        const errMsg =
          (data && data.error) ||
          `Request failed (status ${res.status})`;

        console.error("[CHAT] API returned error:", errMsg, data);
        setMessages((prev) => [
          ...prev,
          {
            role: "error",
            content: `Error from chat API: ${errMsg}`,
          },
        ]);
        return;
      }

      const answerText =
        (data.message &&
          typeof data.message.content === "string" &&
          data.message.content) ||
        (typeof data.aiAnswer === "string" && data.aiAnswer) ||
        "Chat API did not return an answer.";

      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: answerText },
      ]);
    } catch (err) {
      console.error("[CHAT] Network or runtime error:", err);
      setMessages((prev) => [
        ...prev,
        {
          role: "error",
          content:
            "Network error talking to /api/chat. Please check your connection and try again.",
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  async function handleSaveToKb() {
    if (!lastUserMessage || !lastAssistantMessage) {
      setMessages((prev) => [
        ...prev,
        {
          role: "error",
          content:
            "Nothing to save yet. Ask a question and get an answer first.",
        },
      ]);
      return;
    }

    try {
      const res = await fetch("/api/kb-update", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          question: lastUserMessage.content,
          answer: lastAssistantMessage.content,
          source: "Chat Assistant",
        }),
      });

      let data: any = null;
      try {
        data = await res.json();
      } catch (jsonErr) {
        console.error("[KB-SAVE] Failed to parse JSON", jsonErr);
      }

      if (!res.ok || !data || data.ok === false) {
        const msg =
          (data && data.error) ||
          `KB update failed (status ${res.status})`;
        setMessages((prev) => [
          ...prev,
          { role: "error", content: `Save to KB failed: ${msg}` },
        ]);
        return;
      }

      setMessages((prev) => [
        ...prev,
        {
          role: "system",
          content: "✅ Saved latest Q&A pair to the Knowledge Base.",
        },
      ]);
    } catch (err) {
      console.error("[KB-SAVE] Network or runtime error:", err);
      setMessages((prev) => [
        ...prev,
        {
          role: "error",
          content:
            "Network error while saving to Knowledge Base. Please try again.",
        },
      ]);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!loading) {
        handleSend();
      }
    }
  }

  return (
    <div
      style={{
        borderRadius: "16px",
        boxShadow: "0 8px 20px rgba(0,0,0,0.12)",
        padding: "16px",
        maxWidth: "520px",
        margin: "0 auto",
        backgroundColor: "#ffffff",
      }}
    >
      <h2 style={{ fontSize: "1.6rem", fontWeight: 700, marginBottom: "8px" }}>
        Uprise Chat Assistant
      </h2>

      <div
        style={{
          maxHeight: "320px",
          overflowY: "auto",
          padding: "8px 4px",
          marginBottom: "8px",
          border: "1px solid #eee",
          borderRadius: "8px",
        }}
      >
        {messages.length === 0 && (
          <div style={{ color: "#888", fontSize: "0.9rem" }}>
            Ask a question like{" "}
            <em>"how many licensed social workers do we have?"</em>
          </div>
        )}
        {messages.map((m, idx) => {
          const isUser = m.role === "user";
          const isAssistant = m.role === "assistant";
          const isError = m.role === "error";
          const isSystem = m.role === "system";

          const bg = isUser
            ? "#e1f0ff"
            : isAssistant
            ? "#f5f5f5"
            : isError
            ? "#ffe5e5"
            : "#f0f0f0";

          return (
            <div
              key={idx}
              style={{
                marginBottom: "6px",
                padding: "6px 8px",
                borderRadius: "8px",
                backgroundColor: bg,
                fontSize: "0.95rem",
                whiteSpace: "pre-wrap",
              }}
            >
              <strong>
                {isUser
                  ? "You"
                  : isAssistant
                  ? "Assistant"
                  : isError
                  ? "Error"
                  : "System"}
                :
              </strong>{" "}
              {m.content}
            </div>
          );
        })}
      </div>

      <div style={{ display: "flex", gap: "8px", marginBottom: "8px" }}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type your question or command..."
          style={{
            flex: 1,
            padding: "8px 10px",
            borderRadius: "6px",
            border: "1px solid #ccc",
            fontSize: "0.95rem",
          }}
        />
        <button
          onClick={handleSend}
          disabled={loading}
          style={{
            padding: "8px 14px",
            borderRadius: "6px",
            border: "none",
            backgroundColor: loading ? "#888" : "#2563eb",
            color: "#fff",
            fontWeight: 600,
            cursor: loading ? "default" : "pointer",
          }}
        >
          {loading ? "Thinking..." : "Send"}
        </button>
      </div>

      <button
        type="button"
        onClick={handleSaveToKb}
        disabled={!lastUserMessage || !lastAssistantMessage}
        style={{
          padding: "6px 10px",
          borderRadius: "6px",
          border: "1px solid #ccc",
          backgroundColor:
            !lastUserMessage || !lastAssistantMessage ? "#f5f5f5" : "#e0f2fe",
          cursor:
            !lastUserMessage || !lastAssistantMessage
              ? "not-allowed"
              : "pointer",
          fontSize: "0.85rem",
        }}
      >
        💾 Save latest Q&A to Knowledge Base
      </button>
    </div>
  );
}

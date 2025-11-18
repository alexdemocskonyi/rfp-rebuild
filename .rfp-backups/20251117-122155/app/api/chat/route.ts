// app/api/chat/route.ts
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { getEmbedding } from "@/lib/embed";
import { retrieveMatches } from "@/lib/kb";

// SAFE TERMS (never redact)
const SAFE_TERMS = ["Uprise Health", "UPRISE HEALTH", "uprise health"];

// Remove personal names but keep Uprise Health
function stripPersonalNames(text: string): string {
  if (!text) return "";

  let out = text;

  // preserve company name
  SAFE_TERMS.forEach((t) => {
    out = out.replace(new RegExp(t, "gi"), t);
  });

  // Titles + names (Dr. Jane Doe → Dr.)
  out = out.replace(
    /\b(Dr\.|Mr\.|Ms\.|Mrs\.|Prof\.)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g,
    "$1"
  );

  // First Last → [redacted] (but not Uprise Health)
  out = out.replace(/\b[A-Z][a-z]+ [A-Z][a-z]+\b/g, "[redacted]");

  return out;
}

export async function POST(req: NextRequest) {
  try {
    const OPENAI_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_KEY) {
      return NextResponse.json(
        { ok: false, error: "OPENAI_API_KEY missing" },
        { status: 500 }
      );
    }

    const body = await req.json().catch(() => ({}));

    const userText =
      body?.question ||
      body?.prompt ||
      body?.message ||
      (Array.isArray(body?.messages)
        ? body.messages.map((m: any) => m.content).join("\n")
        : "") ||
      "";

    if (!userText.trim()) {
      return NextResponse.json(
        { ok: false, error: "No message provided" },
        { status: 400 }
      );
    }

    const cleanQ = stripPersonalNames(userText.trim());

    // -------------------------------------
    // 1️⃣ Embed question
    // -------------------------------------
    const emb = await getEmbedding(cleanQ);
    if (!emb.length) {
      return NextResponse.json({
        ok: true,
        answer: "Sorry — embedding service returned no vector.",
      });
    }

    // -------------------------------------
    // 2️⃣ Retrieve KB matches
    // -------------------------------------
    const matches = await retrieveMatches(emb, 8, cleanQ);
    const good = (matches || []).filter((m: any) => m.score >= 0.32);

    let candidateBlock = "(none)";
    if (good.length) {
      const dedup = new Set();
      candidateBlock = good
        .map((m: any, idx: number) => {
          const ans = stripPersonalNames(m.answer || "");
          if (!ans || dedup.has(ans.toLowerCase())) return "";
          dedup.add(ans.toLowerCase());
          return `[Answer ${idx + 1}]\n${ans}`;
        })
        .filter(Boolean)
        .join("\n\n");
    }

    // -------------------------------------
    // 3️⃣ GPT synthesis using KB matches
    // -------------------------------------
    const prompt = [
      "You are the Uprise Health RFP Chat Assistant.",
      "Use ONLY the following candidate answers to answer the question.",
      "Normalize legacy vendor names to Uprise Health.",
      "Never claim SOC2 certification.",
      "",
      `Question:\n${cleanQ}`,
      "",
      `Candidate Answers:\n${candidateBlock}`,
      "",
      "If no candidates apply, respond exactly:\nInformation not found in KB.",
    ].join("\n");

    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${OPENAI_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.25,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await resp.json();
    let aiAnswer =
      data?.choices?.[0]?.message?.content?.trim() ||
      "Information not found in KB.";

    aiAnswer = stripPersonalNames(aiAnswer);

    return NextResponse.json({
      ok: true,
      answer: aiAnswer,
      usedCandidates: good?.length || 0,
    });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err.message || "Chat error" },
      { status: 500 }
    );
  }
}

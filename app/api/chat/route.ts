// app/api/chat/route.ts
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { getEmbedding } from "@/lib/embed";
import { retrieveMatches } from "@/lib/kb";

// SAFE TERMS (never redact company name)
const SAFE_TERMS = ["Uprise Health", "UPRISE HEALTH", "uprise health"];

function norm(s: any) {
  return (s ?? "").toString().replace(/\s+/g, " ").trim();
}

/* ----------------------------------
   Policy helpers (ownership / names / location)
------------------------------------ */

function normalizeUpriseLocation(text: string): string {
  if (!text) return text;
  let out = text;

  out = out.replace(/\bJupiter,\s*FL(?:orida)?\b/gi, "Irvine, CA");
  out = out.replace(/\bJupiter\s+Florida\b/gi, "Irvine, CA");

  return out;
}

function scrubIndividualNames(text: string): string {
  if (!text) return text;

  let out = text;

  // preserve company names
  SAFE_TERMS.forEach((t) => {
    out = out.replace(new RegExp(t, "gi"), t);
  });

  // Titles + names (Dr. Jane Doe -> "Dr.")
  out = out.replace(
    /\b(Dr\.|Mr\.|Ms\.|Mrs\.|Prof\.)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g,
    "$1"
  );

  const NON_PEOPLE_WORDS = [
    "Health",
    "Center",
    "Plaza",
    "Building",
    "Services",
    "Corp",
    "LLC",
    "Inc",
    "Systems",
    "Solutions",
    "Behavioral",
  ];

  out = out.replace(
    /\b([A-Z][a-z]+)\s+([A-Z][a-z]+)\b/g,
    (match: string, first: string, last: string) => {
      const combined = first + " " + last;

      if (
        SAFE_TERMS.some(
          (t) => t.toLowerCase() === combined.toLowerCase()
        )
      ) {
        return combined;
      }

      if (NON_PEOPLE_WORDS.indexOf(last) !== -1) return combined;

      return "[redacted]";
    }
  );

  return out;
}

function scrubFemaleOwnershipClaims(text: string): string {
  if (!text) return text;
  let out = text;

  out = out.replace(
    /\b(female|woman|women)[-\s]?owned\b[^.]*\./gi,
    "Ownership or leadership demographics are not provided in this context."
  );

  out = out.replace(
    /\b(female|woman|women)[-\s]?(ceo|cfo|founder|owner|leader|chair|executive|president)\b[^.]*\./gi,
    "Leadership demographics are not provided in this context."
  );

  return out;
}

function isFemaleOwnershipQuestion(q: string): boolean {
  const t = norm(q).toLowerCase();
  return /woman[-\s]?owned|women[-\s]?owned|female[-\s]?owned|minority[-\s]?owned|women[-\s]led|female[-\s]led/.test(
    t
  );
}

function isLeadershipGenderQuestion(q: string): boolean {
  const t = norm(q).toLowerCase();
  return /(male|female|woman|women)\s+(ceo|cfo|founder|owner|leader|chair|executive|president)/.test(
    t
  );
}

function isLocationQuestion(q: string): boolean {
  const t = norm(q).toLowerCase();
  return /(headquarters?|hq|where.*uprise.*located|uprise health location|primary office location|corporate headquarters)/.test(
    t
  );
}

function applyUprisePolicy(question: string, answer: string): string {
  let a = norm(answer);

  if (isFemaleOwnershipQuestion(question) || isLeadershipGenderQuestion(question)) {
    return "Ownership and leadership demographics (including gender or minority status) are not provided; we encourage focusing on Uprise Health’s services and capabilities instead.";
  }

  if (isLocationQuestion(question)) {
    return "Uprise Health is headquartered in Irvine, CA.";
  }

  a = normalizeUpriseLocation(a);
  a = scrubFemaleOwnershipClaims(a);
  a = scrubIndividualNames(a);

  return a;
}

// Original helper name retained, now just wraps scrubIndividualNames
function stripPersonalNames(text: string): string {
  if (!text) return "";
  return scrubIndividualNames(text);
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
    // 1) Embed question
    // -------------------------------------
    const emb = await getEmbedding(cleanQ);
    if (!emb.length) {
      return NextResponse.json({
        ok: true,
        answer: "Sorry — embedding service returned no vector.",
      });
    }

    // -------------------------------------
    // 2) Retrieve KB matches
    // -------------------------------------
    const matches = await retrieveMatches(emb, 8, cleanQ);
    const good = (matches || []).filter((m: any) => m.score >= 0.32);

    let candidateBlock = "(none)";
    if (good.length) {
      const dedup = new Set();
      candidateBlock = good
        .map((m: any, idx: number) => {
          const rawAns = m.answer || "";
          // Apply policy to KB text as well, then strip names
          const policyAns = applyUprisePolicy(cleanQ, rawAns);
          const ans = stripPersonalNames(policyAns);
          if (!ans || dedup.has(ans.toLowerCase())) return "";
          dedup.add(ans.toLowerCase());
          return "[Answer " + (idx + 1) + "]\n" + ans;
        })
        .filter(Boolean)
        .join("\n\n");
    }

    // -------------------------------------
    // 3) GPT synthesis using KB matches
    // -------------------------------------
    const prompt = [
      "You are the Uprise Health RFP Chat Assistant.",
      "Use ONLY the following candidate answers to answer the question.",
      "Normalize legacy vendor names to Uprise Health.",
      "Never claim SOC2 certification.",
      "Do NOT include any individual people’s names in your answer; refer to roles or teams instead.",
      "If the question asks whether Uprise Health is woman-owned, female-owned, minority-owned, or about the gender of owners or executives, do NOT answer that directly; instead say that ownership and leadership demographics are not provided and focus on services and capabilities.",
      "If the question is about Uprise Health’s headquarters or location, always answer that Uprise Health is headquartered in Irvine, CA.",
      "",
      "Question:",
      cleanQ,
      "",
      "Candidate Answers:",
      candidateBlock,
      "",
      "If no candidates apply, respond exactly:",
      "Information not found in KB.",
    ].join("\n");

    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer " + OPENAI_KEY,
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

    // 🔒 Apply hard policy based on the ORIGINAL question text
    aiAnswer = applyUprisePolicy(userText, aiAnswer);
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

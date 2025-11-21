// app/api/chat/route.ts
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { getEmbedding } from "@/lib/embed";
import { retrieveMatches, loadKb, saveKb, type KBItem } from "@/lib/kb";

const SAFE_TERMS = ["Uprise Health", "UPRISE HEALTH", "uprise health"];

function norm(s: any) {
  return (s ?? "").toString().replace(/\s+/g, " ").trim();
}

/* ---------------- Policy helpers ---------------- */

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

  SAFE_TERMS.forEach((t) => {
    out = out.replace(new RegExp(t, "gi"), t);
  });

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

function stripPersonalNames(text: string): string {
  if (!text) return "";
  return scrubIndividualNames(text);
}

/* -------- KB maintenance: numeric updates -------- */

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function looksLikeNumericMaintenance(text: string): boolean {
  const t = text.toLowerCase();
  if (t.startsWith("kb:")) return true;
  if (t.includes("update the kb") || t.includes("update our kb")) return true;
  if (t.includes("change the kb") || t.includes("change the answer in the kb"))
    return true;
  if (t.includes("number of providers") || t.includes("providers answers") || t.includes("provider count"))
    return true;
  if (t.includes("providers being around")) return true;
  return false;
}

// find the most likely "from" number in provider answers, larger than toVal if possible
function guessProviderFromNumber(kb: KBItem[], toVal: number | null): string | null {
  const freq: Record<string, { count: number; value: number }> = {};

  for (const item of kb) {
    const ans = item.answer || "";
    if (!/\bprovider(s)?\b/i.test(ans)) continue;

    const matches = ans.match(/\b[0-9][0-9,]*\b/g);
    if (!matches) continue;

    for (const raw of matches) {
      const val = parseInt(raw.replace(/,/g, ""), 10);
      if (!Number.isFinite(val)) continue;
      if (toVal !== null && val <= toVal) continue;
      const key = raw;
      if (!freq[key]) {
        freq[key] = { count: 0, value: val };
      }
      freq[key].count += 1;
    }
  }

  const keys = Object.keys(freq);
  if (!keys.length) return null;

  keys.sort((a, b) => {
    const fa = freq[a];
    const fb = freq[b];
    if (fb.count !== fa.count) return fb.count - fa.count;
    return fb.value - fa.value;
  });

  return keys[0] || null;
}

async function attemptNumericKbMaintenance(
  userText: string
): Promise<{ handled: boolean; reply?: string }> {
  if (!looksLikeNumericMaintenance(userText)) {
    return { handled: false };
  }

  const lowerCmd = userText.toLowerCase();

  // collect all numbers mentioned in the command
  const numMatches = userText.match(/\b[0-9][0-9,]*\b/g) || [];
  const uniqueNums: string[] = [];
  for (const n of numMatches) {
    if (!uniqueNums.includes(n)) uniqueNums.push(n);
  }

  let fromRaw: string | null = null;
  let toRaw: string | null = null;

  // 1) explicit "from X to Y"
  const explicit = userText.match(/from\s+([0-9][0-9,]*)\s+to\s+([0-9][0-9,]*)/i);
  if (explicit) {
    fromRaw = explicit[1];
    toRaw = explicit[2];
  } else if (uniqueNums.length >= 2) {
    // 2) multiple numbers mentioned: use largest as from, smallest as to
    const parsed = uniqueNums.map((s) => ({
      raw: s,
      val: parseInt(s.replace(/,/g, ""), 10),
    })).filter((x) => Number.isFinite(x.val));

    if (parsed.length >= 2) {
      parsed.sort((a, b) => a.val - b.val);
      const smallest = parsed[0];
      const largest = parsed[parsed.length - 1];
      fromRaw = largest.raw;
      toRaw = smallest.raw;
    }
  } else if (uniqueNums.length === 1) {
    // 3) only one number given (e.g. "around 24000"): treat as new value,
    //    and infer old value from KB provider answers.
    toRaw = uniqueNums[0];
  }

  // Load KB now (needed for both edits and inference)
  const kb: KBItem[] = await loadKb();
  if (!Array.isArray(kb) || kb.length === 0) {
    return {
      handled: true,
      reply: "I tried to update the KB, but it appears to be empty.",
    };
  }

  // If we still do not have toRaw, we cannot proceed
  if (!toRaw) {
    return {
      handled: true,
      reply:
        "I recognized this as a KB maintenance request, but I could not determine the new number. Please include the number you want to change to, for example: kb: change the number of providers answers to 24000.",
    };
  }

  const toNoComma = toRaw.replace(/,/g, "");
  const toVal = parseInt(toNoComma, 10);
  const toWithComma = toNoComma.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

  // If fromRaw is still missing, infer it from KB provider answers
  if (!fromRaw) {
    const guessed = guessProviderFromNumber(kb, Number.isFinite(toVal) ? toVal : null);
    if (!guessed) {
      return {
        handled: true,
        reply:
          "I recognized this as a KB maintenance request, but I could not determine which existing number to replace. Please specify both the old and new values, for example: kb: change the number of providers answers from 60000 to 24000.",
      };
    }
    fromRaw = guessed;
  }

  const fromNoComma = fromRaw.replace(/,/g, "");
  const fromWithComma = fromNoComma.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

  const restrictToProviders =
    lowerCmd.includes("provider") || lowerCmd.includes("providers");

  let changed = 0;

  const fromPatterns = new Set<string>();
  fromPatterns.add(fromRaw);
  fromPatterns.add(fromNoComma);
  fromPatterns.add(fromWithComma);

  const updated: KBItem[] = kb.map((item) => {
    const ans = item.answer || "";
    if (!ans) return item;

    if (restrictToProviders && !/\bprovider(s)?\b/i.test(ans)) {
      return item;
    }

    let newAns = ans;
    for (const fp of fromPatterns) {
      if (!fp) continue;
      const re = new RegExp(escapeRegExp(fp), "g");
      newAns = newAns.replace(re, toWithComma);
    }

    if (newAns !== ans) {
      changed++;
      return { ...item, answer: newAns };
    }
    return item;
  });

  if (changed > 0) {
    await saveKb(updated);
    return {
      handled: true,
      reply:
        "KB updated: replaced occurrences of " +
        fromRaw +
        " with " +
        toWithComma +
        " in " +
        changed +
        " answer(s). This change is now persistent for future chats and reports.",
    };
  }

  return {
    handled: true,
    reply:
      "I attempted a KB update but did not find any answers containing " +
      fromRaw +
      " in the relevant entries, so no changes were made.",
  };
}

/* ---------------- Main chat handler ---------------- */

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

    // 0) Try KB maintenance first
    const maintenance = await attemptNumericKbMaintenance(userText);
    if (maintenance.handled) {
      return NextResponse.json({
        ok: true,
        answer: maintenance.reply || "KB maintenance completed.",
      });
    }

    // 1) Normal Q&A flow
    const cleanQ = stripPersonalNames(userText.trim());

    const emb = await getEmbedding(cleanQ);
    if (!emb.length) {
      return NextResponse.json({
        ok: true,
        answer: "Sorry — embedding service returned no vector.",
      });
    }

    const matches = await retrieveMatches(emb, 8, cleanQ);
    const good = (matches || []).filter((m: any) => m.score >= 0.32);

    let candidateBlock = "(none)";
    if (good.length) {
      const dedup = new Set<string>();
      candidateBlock = good
        .map((m: any, idx: number) => {
          const rawAns = m.answer || "";
          const policyAns = applyUprisePolicy(cleanQ, rawAns);
          const ans = stripPersonalNames(policyAns);
          if (!ans || dedup.has(ans.toLowerCase())) return "";
          dedup.add(ans.toLowerCase());
          return "[Answer " + (idx + 1) + "]\n" + ans;
        })
        .filter(Boolean)
        .join("\n\n");
    }

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

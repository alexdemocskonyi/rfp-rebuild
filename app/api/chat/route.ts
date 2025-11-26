/**
 * app/api/chat/route.ts
 * - Normal chat Q&A against KB (via retrieveMatches)
 * - Magic command:
 *     update: change the answer for <phrase> to <new answer>
 *   which:
 *     1) Stores a sticky override in-memory in this worker
 *     2) Best-effort calls /api/kb-update to persist into the KB
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { POST as kbUpdatePOST } from "@/app/api/kb-update/route";
import { getEmbedding } from "@/lib/embed";
import { retrieveMatches } from "@/lib/kb";

const MODEL = "gpt-4o-mini";
const TOP_K = 10;
const MIN_SCORE = 0.32;

type RawMatch = {
  score: number;
  lexicalScore: number | null;
  source: string;
  snippet: string;
};

type ChatResponse = {
  ok: boolean;
  question: string;
  aiAnswer: string;
  message: { role: "assistant"; content: string };
  rawMatches: RawMatch[];
};

// ---------------------------------------------------------------------
// In-memory sticky overrides: normalizedQuestionKey -> answer
// ---------------------------------------------------------------------
const overrideMap: Record<string, string> = {};

/* ---------------------- small helper functions ---------------------- */

function norm(value: any): string {
  if (value == null) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

function normalizeVendorNames(text: string): string {
  if (text.length === 0) return text;
  return text.replace(
    /\b(H.?C\s*HealthWorks|HMC\s*HealthWorks|HMC\b|IBH\b|Claremont\s+Behavioral\s+Health)\b/gi,
    "Uprise Health"
  );
}

// Normalize a question to a fuzzy key so similar phrasings map together.
function normalizeQuestionKey(q: string): string {
  let s = norm(q).toLowerCase();

  s = s.replace(
    /\b(how many|how much|what is|what are|number of|# of|count of|please describe|describe)\b/g,
    ""
  );

  s = s.replace(/[^a-z0-9]+/g, " ").trim();
  return s;
}

function needsNumeric(question: string): boolean {
  const t = question.toLowerCase();
  return /# of|number of|how many|count|percentage|%|rate|current\s+app\s+store/.test(
    t
  );
}

function safeSnippet(text: string): string {
  try {
    return normalizeVendorNames(norm(text));
  } catch {
    return "";
  }
}

/* -------------------- magic update: command handler ----------------- */

/**
 * Accepts flexible forms like:
 * - "change the answer for licensed social workers to 20669"
 * - "the answer for 'how many psychiatrists' to 2527"
 * - "answer for how many LSWs to 20669"
 */
async function handleUpdateCommand(cmd: string): Promise<ChatResponse> {
  let rest = cmd.trim().replace(/\s+/g, " ");

  // Strip common prefixes
  rest = rest.replace(/^change\s+the\s+answer\s+for\s+/i, "");
  rest = rest.replace(/^change\s+answer\s+for\s+/i, "");
  rest = rest.replace(/^the\s+answer\s+for\s+/i, "");
  rest = rest.replace(/^answer\s+for\s+/i, "");

  // Split on LAST " to " so the answer may contain "to"
  const lower = rest.toLowerCase();
  const idx = lower.lastIndexOf(" to ");
  if (idx === -1) {
    const aiAnswer =
      'I couldn’t parse that update.\n' +
      'Try for example: update: change the answer for "how many psychiatrists" to 2527';
    return {
      ok: true,
      question: cmd,
      aiAnswer,
      message: { role: "assistant", content: aiAnswer },
      rawMatches: [],
    };
  }

  let subjectRaw = rest.slice(0, idx).trim();
  let newAnswerRaw = rest.slice(idx + 4).trim();

  // Strip surrounding quotes
  subjectRaw = subjectRaw.replace(/^["']+|["']+$/g, "");
  newAnswerRaw = newAnswerRaw.replace(/^["']+|["']+$/g, "");

  const subject = norm(subjectRaw);
  const newAnswer = norm(newAnswerRaw);

  if (!subject || !newAnswer) {
    const aiAnswer =
      "Both the question phrase and new answer must be non-empty.";
    return {
      ok: true,
      question: cmd,
      aiAnswer,
      message: { role: "assistant", content: aiAnswer },
      rawMatches: [],
    };
  }

  // 1) Update in-memory override map so it "sticks" for matching questions.
  const overrideKey = normalizeQuestionKey(subject);
  if (overrideKey) {
    overrideMap[overrideKey] = newAnswer;
    console.log("[CHAT] override updated", overrideKey, "->", newAnswer);
  }

  // 2) Best-effort call /api/kb-update to persist into KB
  const payload = {
    question: subject,
    answer: newAnswer,
    source: "chat-update",
  };

  try {
    const kbReq = new NextRequest("http://local/api/kb-update", {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "content-type": "application/json" },
    });

    const kbRes = await kbUpdatePOST(kbReq as any);

    let data: any = null;
    try {
      data = await kbRes.json();
    } catch {
      // kb-update may return an empty body – that's fine
    }

    if (!kbRes.ok || (data && data.ok === false)) {
      const detail =
        data && typeof data.error === "string" && data.error
          ? " Details: " + data.error
          : "";
      const aiAnswer =
        "Override stored for this worker, but server-side KB update may have failed." +
        detail;
      // Still ok:true so the UI shows this as a normal assistant reply
      return {
        ok: true,
        question: subject,
        aiAnswer,
        message: { role: "assistant", content: aiAnswer },
        rawMatches: [],
      };
    }
  } catch (err: any) {
    console.error("[CHAT] kb-update error", err);
    const aiAnswer =
      "Override stored for this worker, but calling /api/kb-update threw an exception: " +
      (err?.message || String(err));
    return {
      ok: true,
      question: subject,
      aiAnswer,
      message: { role: "assistant", content: aiAnswer },
      rawMatches: [],
    };
  }

  const aiAnswer = `KB updated: set answer for "${subject}" to: ${newAnswer}`;
  return {
    ok: true,
    question: subject,
    aiAnswer,
    message: { role: "assistant", content: aiAnswer },
    rawMatches: [],
  };
}

/* ------------------------ main chat handler ------------------------- */

export async function POST(req: NextRequest) {
  console.log("[CHAT] Request received");

  try {
    let body: any = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    const messageRaw =
      typeof body.message === "string" && body.message.trim().length > 0
        ? body.message.trim()
        : typeof body.question === "string"
        ? body.question.trim()
        : "";

    if (!messageRaw) {
      return NextResponse.json(
        { ok: false, error: "Empty message" },
        { status: 400 }
      );
    }

    // Magic update: command (always return HTTP 200 so UI doesnt show generic error)
    if (messageRaw.toLowerCase().startsWith("update:")) {
      const cmd = messageRaw.slice("update:".length).trim();
      const updateResult = await handleUpdateCommand(cmd);
      return NextResponse.json(updateResult, { status: 200 });
    }

    const question = messageRaw;

    // Check sticky overrides first
    const overrideKey = normalizeQuestionKey(question);
    if (overrideKey && overrideMap[overrideKey]) {
      const aiAnswer = overrideMap[overrideKey];
      const responsePayload: ChatResponse = {
        ok: true,
        question,
        aiAnswer,
        message: { role: "assistant", content: aiAnswer },
        rawMatches: [],
      };
      return NextResponse.json(responsePayload);
    }

    const OPENAI_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_KEY) {
      throw new Error("Missing OPENAI_API_KEY");
    }

    const emb = await getEmbedding(question);
    const matches = await retrieveMatches(emb, TOP_K, question);

    // First, try strict threshold; if nothing passes, fall back to all matches.
    let good = (matches || []).filter(
      (m: any) => m.score >= MIN_SCORE && m.answer
    );

    if (good.length === 0 && matches && matches.length > 0) {
      console.log(
        "[CHAT] No matches >= MIN_SCORE; falling back to top matches anyway."
      );
      good = matches.filter((m: any) => m.answer);
    }

    const seen = new Set<string>();
    const deduped: any[] = [];

    for (const m of good) {
      const answerText = norm(m.answer);
      const key = answerText.toLowerCase();
      if (!key) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(m);
    }

    const candidateBlock =
      deduped.length > 0
        ? deduped
            .map(
              (m, idx) =>
                "[Answer " +
                String(idx + 1) +
                "]\n" +
                normalizeVendorNames(norm(m.answer))
            )
            .join("\n\n")
        : "(none)";

    let aiAnswer = "Information not found in KB.";

    try {
      if (deduped.length > 0) {
        const prompt =
          "You are an expert RFP analyst for Uprise Health.\n" +
          "Use ONLY facts from the candidate answers provided.\n" +
          "Normalize any legacy vendor names to Uprise Health.\n" +
          "If nothing applies, respond exactly: Information not found in KB.\n\n" +
          "Question:\n" +
          question +
          "\n\nCandidate answers:\n" +
          candidateBlock;

        const resp = await fetch(
          "https://api.openai.com/v1/chat/completions",
          {
            method: "POST",
            headers: {
              authorization: "Bearer " + OPENAI_KEY,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              model: MODEL,
              messages: [{ role: "user", content: prompt }],
              temperature: 0.25,
            }),
          }
        );

        const data = await resp.json();
        const modelAnswer =
          data &&
          Array.isArray(data.choices) &&
          data.choices[0] &&
          data.choices[0].message &&
          typeof data.choices[0].message.content === "string"
            ? data.choices[0].message.content.trim()
            : "";

        if (modelAnswer) {
          aiAnswer = normalizeVendorNames(modelAnswer);
        }
      }
    } catch (err) {
      console.error("[CHAT] GPT error", err);
    }

    if (needsNumeric(question) && !/[0-9%]/.test(aiAnswer)) {
      aiAnswer = "N/A (not available in KB).";
    }

    const rawMatches: RawMatch[] = deduped.map((m: any) => ({
      score: m.score,
      lexicalScore:
        typeof m.lexicalScore === "number" ? m.lexicalScore : null,
      source: m.source || m.origin || "Unknown source",
      snippet: safeSnippet(m.answer),
    }));

    const responsePayload: ChatResponse = {
      ok: true,
      question,
      aiAnswer,
      message: { role: "assistant", content: aiAnswer },
      rawMatches,
    };

    return NextResponse.json(responsePayload);
  } catch (err: any) {
    console.error("[CHAT] ERROR", err);
    return NextResponse.json(
      { ok: false, error: err?.message || "Unknown error" },
      { status: 500 }
    );
  }
}

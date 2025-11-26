// lib/kb.ts
import stringSimilarity from "string-similarity";
import { put } from "@vercel/blob";

export type KBItem = {
  // Core fields
  kind?: "qa" | "context"; // default: "qa" if omitted
  question?: string;
  answer?: string;
  content?: string; // for free-form context chunks
  embedding?: number[] | string;

  // Provenance
  source?: string;
  sourceFile?: string;
  doc?: string;
  origin?: string;

  // Any legacy / extra fields
  [key: string]: any;
};

// Scored view used internally
export type KBScoredItem = KBItem & {
  score?: number;
  semanticScore?: number;
  lexicalScore?: number;
};

// Public blob where kb.json lives
const KB_BASE = "https://ynyzmdodop38gqsz.public.blob.vercel-storage.com";
const KB_PATH = "kb.json";

// ---------- utils ----------
function cosine(a: number[], b: number[]) {
  if (!a?.length || !b?.length) return 0;
  const n = Math.min(a.length, b.length);
  let dot = 0,
    magA = 0,
    magB = 0;
  for (let i = 0; i < n; i++) {
    const ai = Number(a[i]) || 0;
    const bi = Number(b[i]) || 0;
    dot += ai * bi;
    magA += ai * ai;
    magB += bi * bi;
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB) || 1);
}

// Expand abbreviations / aliases in both KB and queries
function applyAliases(text: string) {
  return (text || "").replace(/\blsws?\b/gi, "licensed social workers");
}

function norm(s: any) {
  return applyAliases((s ?? "").toString()).replace(/\s+/g, " ").trim();
}

function normalizeVendorNames(text: string) {
  if (!text) return text;
  return text.replace(
    /\b(H.?C\s*HealthWorks|HMC\s*HealthWorks|HMC\b|IBH\b|Claremont\s+Behavioral\s+Health)\b/gi,
    "Uprise Health"
  );
}

function isGarbageAnswer(a: string) {
  const t = norm(a).toLowerCase();
  if (!t) return true;
  if (t.length < 2) return true;
  if (/^(n\/a|na|none|null|tbd|n\s*a|n-?\/-?a|\-)$/.test(t)) return true;
  if (/^[a-z]$/.test(t)) return true; // single letter
  if (/lorem ipsum|dummy|test/i.test(t)) return true;
  if (/^([.,;:!?()\[\]\-_/\\\s])+$/.test(t)) return true;
  return false;
}

function isQaKind(item: KBItem) {
  return (item.kind ?? "qa") === "qa";
}

function isContextKind(item: KBItem) {
  return item.kind === "context";
}

// ---------- KB I/O ----------
export async function loadKb(): Promise<KBItem[]> {
  const ts = Date.now();
  const url = `${KB_BASE}/${KB_PATH}?nocache=${ts}`;
  console.log(`[KB] Fetching from ${url}`);

  const res = await fetch(url, {
    cache: "no-store",
    headers: { pragma: "no-cache", "cache-control": "no-cache" },
  });

  if (!res.ok) {
    console.error(`[KB] HTTP ${res.status} loading kb.json`);
    return [];
  }

  const text = await res.text();
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error("❌ KB PARSE ERROR", err);
    console.log("Raw snippet:", text.slice(0, 300));
    return [];
  }
}

export async function saveKb(items: KBItem[]) {
  const token =
    process.env.BLOB_READ_WRITE_TOKEN ||
    process.env.VERCEL_BLOB_READ_WRITE_TOKEN;

  if (!token) {
    console.warn("[KB] No blob write token set; running in read-only mode.");
    return { ok: false, error: "No blob write token set" };
  }

  const body = JSON.stringify(items, null, 2);

  try {
    const r = await put(KB_PATH, body, {
      access: "public",
      addRandomSuffix: false, // keep the same filename
      allowOverwrite: true, // allow overwriting existing kb.json
      contentType: "application/json",
      token,
    });
    console.log(`[KB] Saved ${items.length} rows to ${r.url}`);
    return { ok: true, url: r.url };
  } catch (err: any) {
    console.error("❌ KB SAVE ERROR", err?.message || err);
    throw err;
  }
}

// ---------- Core scoring helper ----------
function scoreRowsForQuery(
  rows: KBItem[],
  queryEmbedding: number[],
  queryText?: string,
  mode: "qa" | "context" = "qa"
): KBScoredItem[] {
  const qNorm = norm(queryText || "").toLowerCase();

  return rows
    .map((x) => {
      let e: any = x.embedding;
      if (typeof e === "string") {
        try {
          e = JSON.parse(e);
        } catch {
          e = [];
        }
      }

      let question = norm(x.question);
      let answer = normalizeVendorNames(norm(x.answer));
      let content = norm(x.content);

      // For QA, primary text is question+answer; for context, primary is content (or fallback)
      let lexicalText: string;
      if (mode === "qa") {
        lexicalText = `${question || ""} ${answer || ""}`;
      } else {
        lexicalText = content || answer || question || "";
      }

      const embeddingArray: number[] = Array.isArray(e)
        ? e.map((n: any) => Number(n) || 0)
        : [];

      let semantic = 0;
      if (
        queryEmbedding &&
        queryEmbedding.length > 0 &&
        embeddingArray.length > 0
      ) {
        const n = Math.min(queryEmbedding.length, embeddingArray.length);
        semantic = cosine(
          queryEmbedding.slice(0, n),
          embeddingArray.slice(0, n)
        );
      }

      let lexical = 0;
      if (qNorm) {
        lexical = stringSimilarity.compareTwoStrings(
          qNorm,
          norm(lexicalText).toLowerCase()
        );
      }

      const finalScore =
        embeddingArray.length > 0 && queryEmbedding.length > 0
          ? 0.7 * semantic + 0.3 * lexical
          : lexical;

      const base: KBItem = {
        ...x,
        question,
        answer,
        content,
        embedding: embeddingArray,
      };

      return {
        ...base,
        score: finalScore,
        semanticScore: semantic,
        lexicalScore: lexical,
      };
    })
    .sort((a, b) => (b.score || 0) - (a.score || 0));
}

// ---------- Retrieval WITH context chunks ----------
export async function retrieveMatchesWithContext(
  queryEmbedding: number[],
  qaLimit = 5,
  contextLimit = 5,
  queryText?: string
): Promise<{ qaMatches: KBScoredItem[]; contextMatches: KBScoredItem[] }> {
  const kb = await loadKb();
  if (!Array.isArray(kb) || kb.length === 0) {
    console.warn("⚠️ KB empty or invalid");
    return { qaMatches: [], contextMatches: [] };
  }

  const qaRaw = kb.filter((x) => isQaKind(x));
  const ctxRaw = kb.filter((x) => isContextKind(x));

  const qaPrepared = qaRaw
    .map((x) => ({
      ...x,
      answer: normalizeVendorNames(norm(x.answer)),
      question: norm(x.question),
    }))
    .filter(
      (x) =>
        x.answer &&
        x.answer.trim().length > 0 &&
        x.answer.trim().length >= 3
    );

  const ctxPrepared = ctxRaw
    .map((x) => ({
      ...x,
      content: norm(x.content || x.answer || x.question),
    }))
    .filter((x) => x.content && x.content.trim().length > 0);

  console.log(
    `[KB] Normalized QA rows (with usable answers): ${qaPrepared.length}/${qaRaw.length}`
  );
  console.log(
    `[KB] Normalized context rows (with usable content): ${ctxPrepared.length}/${ctxRaw.length}`
  );

  const qaScored = qaPrepared.length
    ? scoreRowsForQuery(qaPrepared, queryEmbedding, queryText, "qa").slice(
        0,
        Math.min(qaLimit, qaPrepared.length)
      )
    : [];

  const ctxScored = ctxPrepared.length
    ? scoreRowsForQuery(
        ctxPrepared,
        queryEmbedding,
        queryText,
        "context"
      ).slice(0, Math.min(contextLimit, ctxPrepared.length))
    : [];

  return { qaMatches: qaScored, contextMatches: ctxScored };
}

// ---------- Retrieval (legacy: Q&A only) ----------
export async function retrieveMatches(
  queryEmbedding: number[],
  limit = 5,
  queryText?: string
) {
  const { qaMatches } = await retrieveMatchesWithContext(
    queryEmbedding,
    limit,
    0,
    queryText
  );

  if (qaMatches.length) {
    console.log(
      `[KB] Top ${qaMatches.length} QA matches (final/semantic/lexical):`,
      qaMatches.map(
        (s) =>
          `${(s.score || 0).toFixed(3)}/${(s.semanticScore || 0).toFixed(
            3
          )}/${(s.lexicalScore || 0).toFixed(3)}`
      )
    );
    return qaMatches;
  }

  console.log(
    "[KB] No QA matches scored; returning empty array (KB may still have context rows)."
  );
  return [];
}

// ---------- Single-answer overwrite helper ----------
export async function updateOrInsertAnswer(
  question: string,
  newAnswer: string,
  source?: string,
  embedding?: number[]
): Promise<KBItem> {
  const kb = await loadKb();

  const qKey = norm(question).toLowerCase();
  const sKey = norm(source || "");

  let target: KBItem | undefined;

  for (const row of kb) {
    if (!isQaKind(row)) continue;
    const rowQ = norm(row.question).toLowerCase();
    const rowS = norm(row.source || "").toLowerCase();
    if (rowQ === qKey && (sKey === "" || rowS === sKey)) {
      target = row;
      break;
    }
  }

  const normalizedAnswer = normalizeVendorNames(norm(newAnswer));

  if (target) {
    target.answer = normalizedAnswer;
    if (embedding && Array.isArray(embedding)) {
      target.embedding = embedding;
    }
    if (!target.kind) target.kind = "qa";
    if (!target.source && source) target.source = source;
    console.log(
      `[KB] Updated existing answer for question="${qKey}" source="${sKey}"`
    );
  } else {
    const item: KBItem = {
      kind: "qa",
      question: norm(question),
      answer: normalizedAnswer,
      source: source || "manual-edit",
      embedding: Array.isArray(embedding) ? embedding : [],
      origin: "manual-update",
    };
    kb.push(item);
    target = item;
    console.log(
      `[KB] Inserted new QA item for question="${qKey}" source="${sKey}"`
    );
  }

  await saveKb(kb);
  return target;
}

// ---------- Hygiene / Maintenance ----------
type SanitizeOpts = {
  minAnswerLen?: number;
  useGPT?: boolean;
  openaiKey?: string;
};

export function sanitizeKb(items: KBItem[], opts: SanitizeOpts = {}) {
  const minAnswerLen = opts.minAnswerLen ?? 8;

  // Split QA vs context; we only sanitize QA, pass context through unchanged
  const qaItems = items.filter((x) => isQaKind(x));
  const contextItems = items.filter((x) => isContextKind(x));

  // 1) normalize + hard filters (QA only)
  const pre = qaItems
    .map((x) => ({
      ...x,
      question: norm(x.question),
      answer: normalizeVendorNames(norm(x.answer)),
    }))
    .filter(
      (x) =>
        x.question &&
        x.answer &&
        !isGarbageAnswer(x.answer) &&
        x.answer.length >= minAnswerLen
    );

  // 2) dedupe exact (safe): question|answer
  const key = (x: KBItem) =>
    `${String(x.question || "").toLowerCase()}|${String(
      x.answer || ""
    ).toLowerCase()}`;
  const seen = new Set<string>();
  const dedup: KBItem[] = [];
  for (const it of pre) {
    const k = key(it);
    if (seen.has(k)) continue;
    seen.add(k);
    dedup.push(it);
  }

  // 3) optional GPT pass for borderline rows
  const cleanedQa = !opts.useGPT || !opts.openaiKey
    ? dedup
    : // gptFilter only looks at question/answer; context rows are separate
      // and we append them unchanged below.
      // eslint-disable-next-line @typescript-eslint/no-use-before-define
      gptFilter(dedup, opts.openaiKey);

  return [...cleanedQa, ...contextItems];
}

async function gptFilter(items: KBItem[], key: string): Promise<KBItem[]> {
  const MODEL = "gpt-4o-mini";
  const chunkSize = 50;
  const keep: KBItem[] = [];

  for (let i = 0; i < items.length; i += chunkSize) {
    const slice = items.slice(i, i + chunkSize);

    const payload = slice.map(({ question, answer }) => ({
      question,
      answer,
    }));

    const prompt = `
You are cleaning a global knowledge base of Q/A pairs used to answer MANY different RFPs/RFIs for Uprise Health.

For EACH item in the list, decide whether to KEEP it in the global reusable KB, or DROP it.

Think like a very strict human editor with good judgment.

KEEP an item ONLY if:
- The answer contains concrete, reusable facts about Uprise Health services, policies, capabilities, network, processes, SLAs, security, etc.
- It would make sense to reuse this answer (or most of it) for FUTURE RFPs from different clients.
- It is not obviously tied to one specific customer, one contract, or one local situation.

DROP an item if ANY of the following are true:
- The answer is placeholder/junk: N/A, TBD, "-", ".", "200 words", lorem ipsum, test text, or basically empty.
- The answer is vague marketing fluff with no real facts ("we are committed to excellence", "we greatly value our clients").
- The question/answer clearly refers to ONE SPECIFIC RFP/RFI, client, or entity, for example:
  - Mentions a specific government, school district, employer, or plan by name (e.g. "City of ___", "County of ___", "ABC School District", "XYZ Corporation").
  - Mentions a particular contract, bid number, or RFP identifier ("RFP #1234", "Bid 2025-001").
  - Talks about "this RFP", "this proposal", "this contract", "this engagement", or "your organization" in a way that is clearly tied to a single client.
  - Describes very local/one-off situations that obviously do NOT generalize (e.g. "For your employees in Northern California we will use ___", "For this client we have providers on-site at 123 Main Street").
- The answer contains personal identifying info about a specific client, person, or site (names, specific addresses, etc.) that makes it clearly not generic KB material.
- The content is off-topic or not about Uprise Health’s offerings / operations.

IMPORTANT:
- When in doubt, be conservative: if you are not sure that a Q/A is globally reusable for many RFPs, DROP it.
- Do NOT try to rewrite or fix answers; just decide KEEP (true) or DROP (false).

Return a JSON array of booleans, same length and order as the input list.
Each element MUST be exactly true (keep) or false (drop).

INPUT:
${JSON.stringify(payload)}
`.trim();

    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await resp.json();
    let raw: string = data?.choices?.[0]?.message?.content || "[]";

    // Try to isolate the JSON array if there is any extra text
    const first = raw.indexOf("[");
    const last = raw.lastIndexOf("]");
    if (first !== -1 && last !== -1) {
      raw = raw.slice(first, last + 1);
    }

    let decisions: boolean[] = [];
    try {
      decisions = JSON.parse(raw);
    } catch {
      // If parsing fails, fall back to KEEP everything in this slice
      decisions = slice.map(() => true);
    }

    for (let j = 0; j < slice.length; j++) {
      if (decisions[j]) {
        keep.push(slice[j]);
      }
    }
  }

  return keep;
}

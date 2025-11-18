// lib/kb.ts
import stringSimilarity from "string-similarity";
import { put } from "@vercel/blob";

export type KBItem = {
  question: string;
  answer: string;
  embedding?: number[] | string;
  source?: string;
  sourceFile?: string;
  doc?: string;
  origin?: string;
  [key: string]: any;
};

// ✅ same blob base you’re already using
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

function norm(s: any) {
  return (s ?? "").toString().replace(/\s+/g, " ").trim();
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
    process.env.BLOB_READ_WRITE_TOKEN || process.env.VERCEL_BLOB_READ_WRITE_TOKEN;
  if (!token) {
    console.warn("[KB] No blob write token set; running in read-only mode.");
    return;
  }
  const body = JSON.stringify(items, null, 2);
  const r = await put(KB_PATH, body, {
    access: "public",
    addRandomSuffix: false,
    contentType: "application/json",
    token,
  });
  console.log(`[KB] Saved ${items.length} rows to ${r.url}`);
}

// ---------- Retrieval (unchanged behavior) ----------
export async function retrieveMatches(
  queryEmbedding: number[],
  limit = 5,
  queryText?: string
) {
  const kb = await loadKb();
  if (!Array.isArray(kb) || kb.length === 0) {
    console.warn("⚠️ KB empty or invalid");
    return [];
  }

  const valid = kb
    .map((x: any) => {
      let e: any = x.embedding;
      if (typeof e === "string") {
        try {
          e = JSON.parse(e);
        } catch {
          e = [];
        }
      }

      const answer = norm(x.answer);
      const question = norm(x.question);

      return {
        ...x,
        question,
        answer,
        embedding: Array.isArray(e) ? e.map((n: any) => Number(n) || 0) : [],
      };
    })
    .filter(
      (x) =>
        x.embedding.length === 1536 &&
        x.answer &&
        x.answer.trim().length > 0
    );

  console.log(`[KB] Valid embeddings (with answers): ${valid.length}/${kb.length}`);

  const qNorm = norm(queryText || "").toLowerCase();

  const scored = valid
    .map((x) => {
      const semantic = cosine(queryEmbedding, x.embedding);
      let lexical = 0;
      if (qNorm) {
        const combo = `${x.question || ""} ${x.answer || ""}`;
        lexical = stringSimilarity.compareTwoStrings(
          qNorm,
          norm(combo).toLowerCase()
        );
      }
      const finalScore = 0.75 * semantic + 0.25 * lexical;
      return {
        ...x,
        score: finalScore,
        semanticScore: semantic,
        lexicalScore: lexical,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  console.log(
    `[KB] Top ${scored.length} matches (final/semantic/lexical):`,
    scored.map(
      (s) =>
        `${s.score.toFixed(3)}/${s.semanticScore.toFixed(3)}/${s.lexicalScore.toFixed(3)}`
    )
  );

  return scored;
}

// ---------- Hygiene / Maintenance ----------
type SanitizeOpts = {
  minAnswerLen?: number;
  useGPT?: boolean;
  openaiKey?: string;
};

export function sanitizeKb(items: KBItem[], opts: SanitizeOpts = {}) {
  const minAnswerLen = opts.minAnswerLen ?? 8;

  // 1) normalize + hard filters
  const pre = items
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
  const key = (x: KBItem) => `${x.question.toLowerCase()}|${x.answer.toLowerCase()}`;
  const seen = new Set<string>();
  const dedup: KBItem[] = [];
  for (const it of pre) {
    const k = key(it);
    if (seen.has(k)) continue;
    seen.add(k);
    dedup.push(it);
  }

  // 3) optional GPT pass for borderline rows
  if (!opts.useGPT || !opts.openaiKey) return dedup;

  return gptFilter(dedup, opts.openaiKey);
}

async function gptFilter(items: KBItem[], key: string): Promise<KBItem[]> {
  const MODEL = "gpt-4o-mini";
  const chunkSize = 50;
  const keep: KBItem[] = [];

  for (let i = 0; i < items.length; i += chunkSize) {
    const slice = items.slice(i, i + chunkSize);
    const prompt = `
Judge if each Q/A is a valid, specific knowledge-base fact for enterprise RFP answering.

Rules:
- KEEP if the answer contains concrete information useful to answer future RFPs.
- DROP if the answer is a single word/letter, generic marketing fluff with no facts, placeholders (e.g., N/A, TBD), lorem/test, or off-topic.
- Return JSON array of "keep" booleans, same length/order as input.

Only output JSON.

INPUT:
${JSON.stringify(slice.map(({ question, answer }) => ({ question, answer })))}
`.trim();

    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: MODEL, temperature: 0, messages: [{ role: "user", content: prompt }] }),
    });

    const data = await resp.json();
    let raw: string = data?.choices?.[0]?.message?.content || "[]";
    const first = raw.indexOf("[");
    const last = raw.lastIndexOf("]");
    if (first !== -1 && last !== -1) raw = raw.slice(first, last + 1);

    let decisions: boolean[] = [];
    try { decisions = JSON.parse(raw); } catch { decisions = slice.map(() => true); }

    for (let j = 0; j < slice.length; j++) {
      if (decisions[j]) keep.push(slice[j]);
    }
  }
  return keep;
}

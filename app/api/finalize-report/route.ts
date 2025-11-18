export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";

const MODEL = "gpt-4o-mini";
const BATCH = 20;

function norm(s: any) {
  return (s ?? "").toString().replace(/\s+/g, " ").trim();
}

export async function POST(req: NextRequest) {
  try {
    const { items } = await req.json();
    if (!Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ ok: false, error: "No items" }, { status: 400 });
    }

    const OPENAI_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_KEY) throw new Error("Missing OPENAI_API_KEY");

    const cleanedItems: any[] = [];
    const conflictsAll: any[] = [];

    for (let i = 0; i < items.length; i += BATCH) {
      const chunk = items.slice(i, i + BATCH);

      const instruction = `
You are a meticulous RFP QA editor.

For each item:
- Only use content present in the provided snippets (contextual/raw).
- If answer is unsupported or nonsense → "Information not found in KB."
- If question expects numbers and none appear in snippets → "N/A (not available in KB)."
- If two sources in the item conflict and can't be resolved → "Omitted: conflicting data — requires manual review."

Also return a 'conflicts' array for the chunk with {index, reason} where you found contradictions.

Return ONLY JSON:
{
  "items": [
    {"question": "...", "aiAnswer": "...", "sourcesUsed": [...], "contextualMatches":[{source:"",snippet:""}], "rawTextMatches":[{source:"",snippet:""}]}
  ],
  "conflicts": [
    {"index": <0-based index within this chunk>, "reason": "..." }
  ]
}
      `.trim();

      const payload = {
        model: MODEL,
        temperature: 0,
        messages: [
          { role: "system", content: instruction },
          { role: "user", content: JSON.stringify({ items: chunk }) },
        ],
      };

      const resp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${OPENAI_KEY}`,
        },
        body: JSON.stringify(payload),
      });

      const data = await resp.json();
      let raw = data?.choices?.[0]?.message?.content || "{}";
      const first = raw.indexOf("{");
      const last = raw.lastIndexOf("}");
      if (first !== -1 && last !== -1) raw = raw.slice(first, last + 1);

      let parsed: any;
      try { parsed = JSON.parse(raw); }
      catch {
        // soft-fail: keep originals for this chunk
        cleanedItems.push(...chunk);
        continue;
      }

      const outItems = Array.isArray(parsed.items) ? parsed.items : chunk;
      const conflicts = Array.isArray(parsed.conflicts) ? parsed.conflicts : [];

      // normalize & push
      outItems.forEach((it: any) => {
        cleanedItems.push({
          question: norm(it.question),
          aiAnswer: norm(it.aiAnswer || "Information not found in KB."),
          sourcesUsed: Array.isArray(it.sourcesUsed) ? it.sourcesUsed : [],
          contextualMatches: Array.isArray(it.contextualMatches) ? it.contextualMatches : [],
          rawTextMatches: Array.isArray(it.rawTextMatches) ? it.rawTextMatches : [],
        });
      });

      // offset conflict indices to global
      conflicts.forEach((c: any) => {
        conflictsAll.push({
          questionIndex: i + Number(c.index || 0),
          reason: norm(c.reason || "conflict"),
        });
      });
    }

    return NextResponse.json({ ok: true, items: cleanedItems, conflicts: conflictsAll });
  } catch (err: any) {
    console.error("❌ FINALIZE_ERROR", err);
    return NextResponse.json({ ok: false, error: err.message || "Unknown error" }, { status: 500 });
  }
}

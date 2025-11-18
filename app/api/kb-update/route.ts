// app/api/kb-update/route.ts
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { put } from "@vercel/blob";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

const BLOB_BASE_URL =
  process.env.BLOB_BASE_URL || "https://ynyzmdodop38gqsz.public.blob.vercel-storage.com";
const BLOB_TOKEN =
  process.env.BLOB_READWRITE_TOKEN ||
  "vercel_blob_rw_YnyZMdOdop38gqSz_5D6vQd4WlLmEGx76qZpzxpSfne7Ms4";
const KB_PATH = "kb.json";

async function getEmbedding(text: string): Promise<number[]> {
  try {
    const res = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: text.slice(0, 8000),
    });
    return res.data[0].embedding;
  } catch (err) {
    console.error("❌ EMBED_ERROR", err);
    return [];
  }
}

function normalize(s: string) {
  return (s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const question = (body.question || "").trim();
    const answer = (body.answer || "").trim();
    const source = body.source || "manual";

    if (!question || !answer)
      return NextResponse.json(
        { ok: false, error: "Missing question or answer" },
        { status: 400 }
      );

    const embedding = await getEmbedding(`${question}\n${answer}`);
    const kbUrl = `${BLOB_BASE_URL}/${KB_PATH}`;
    let kb: any[] = [];

    try {
      const res = await fetch(kbUrl, { cache: "no-store" });
      if (res.ok) kb = await res.json();
    } catch (err) {
      console.log("ℹ️ No existing KB found");
    }

    const normQ = normalize(question);
    let updated = false;

    // Update if existing, else add new
    for (const item of kb) {
      if (normalize(item.question) === normQ) {
        item.answer = answer;
        item.embedding = embedding;
        item.source = source;
        updated = true;
        console.log(`✏️ Updated KB entry for: ${question}`);
        break;
      }
    }

    if (!updated) {
      kb.push({ question, answer, embedding, source });
      console.log(`➕ Added new KB entry: ${question}`);
    }

    await put(KB_PATH, JSON.stringify(kb, null, 2), {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
      token: BLOB_TOKEN,
      contentType: "application/json",
    });

    return NextResponse.json({ ok: true, total: kb.length });
  } catch (err: any) {
    console.error("❌ KB_UPDATE_ERROR", err);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}

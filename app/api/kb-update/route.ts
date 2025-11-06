import { NextResponse } from "next/server";
import OpenAI from "openai";
import { put } from "@vercel/blob";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const { question, answer } = await req.json();
    if (!question || !answer)
      return NextResponse.json({ error: "Missing question or answer" }, { status: 400 });

    // Generate embedding
    const embRes = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: question,
    });
    const embedding = embRes.data[0].embedding;

    // Fetch existing KB
    const res = await fetch("https://nwavns9phcxcbmyj.public.blob.vercel-storage.com/kb.json");
    const kb = await res.json();

    // Append new entry
    kb.push({
      id: crypto.randomUUID(),
      question,
      answer,
      embedding,
      source: "chat-update",
      updatedAt: new Date().toISOString(),
    });

    // Save new KB back to Vercel Blob
    const blob = await put("kb.json", JSON.stringify(kb, null, 2), {
      access: "public",
      contentType: "application/json",
    });

    return NextResponse.json({ ok: true, count: kb.length, blobUrl: blob.url });
  } catch (err: any) {
    console.error("KB_UPDATE_ERROR", err);
    return NextResponse.json({ error: err.message || "Failed to update KB" }, { status: 500 });
  }
}

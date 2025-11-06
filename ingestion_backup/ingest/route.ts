import { NextRequest, NextResponse } from "next/server";
import { put } from "@vercel/blob";
import * as XLSX from "xlsx";

export const runtime = "nodejs";
const KB_PATH = "kb.json";
const BATCH = 12;

async function getEmbeddingSafe(text: string, attempt = 1): Promise<number[]> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("Missing OPENAI_API_KEY");
  try {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ input: text, model: "text-embedding-3-small" }),
    });
    if (!res.ok) {
      const body = await res.text();
      // Retry only on 502 / 429 / 500 / 524 etc.
      if ((res.status === 502 || res.status === 429 || res.status === 524 || res.status === 500) && attempt <= 5) {
        const wait = 1500 * attempt;
        console.warn(`⚠️ OpenAI error ${res.status}, retrying in ${wait}ms (attempt ${attempt})`);
        await new Promise(r => setTimeout(r, wait));
        return getEmbeddingSafe(text, attempt + 1);
      }
      throw new Error(`OpenAI error ${res.status}: ${body}`);
    }
    const data = await res.json();
    return data.data?.[0]?.embedding ?? [];
  } catch (err: any) {
    if (attempt <= 5) {
      const wait = 1500 * attempt;
      console.warn(`⚠️ Network error (${err.message}), retrying in ${wait}ms`);
      await new Promise(r => setTimeout(r, wait));
      return getEmbeddingSafe(text, attempt + 1);
    }
    console.error("❌ EMBED FAIL:", err);
    return [];
  }
}

function normalizeQ(q: string) {
  return q.toLowerCase().replace(/\s+/g, " ").trim();
}

function parseCsv(buf: Buffer) {
  const text = buf.toString("utf-8");
  const lines = text.split(/\r?\n/).filter(l => l.trim().length);
  const header = lines[0].toLowerCase();
  const body = header.includes("question") ? lines.slice(1) : lines;
  return body.map(line => {
    const m = line.match(/^(.*?),(.*)$/s);
    const q = (m ? m[1] : line).trim().replace(/^\uFEFF/, "");
    const a = (m ? m[2] : "").trim();
    return { question: q, answer: a };
  }).filter(r => r.question);
}

function parseXlsx(buf: Buffer) {
  const wb = XLSX.read(buf, { type: "buffer" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows: any[] = XLSX.utils.sheet_to_json(sheet, { defval: "" });
  return rows.map(r => ({
    question: (r.Question ?? r["﻿Question"] ?? r.question ?? r.Q ?? r.prompt ?? "").toString().trim(),
    answer: (r.Answer ?? r["Answer "] ?? r.answer ?? r.A ?? r.Response ?? "").toString().trim(),
  })).filter(r => r.question);
}

export async function POST(req: NextRequest) {
  try {
    const data = await req.formData();
    const file = data.get("file") as File;
    if (!file) throw new Error("No file provided");
    const ab = await file.arrayBuffer();
    const buf = Buffer.from(ab);
    const parsed = file.name.endsWith(".csv") ? parseCsv(buf) : parseXlsx(buf);
    console.log(`Parsed ${parsed.length} rows`);

    const uploaded = await put(`uploads/${file.name}`, buf, { access: "public", addRandomSuffix: true });
    console.log("Blob uploaded:", uploaded.url);

    const base = new URL(uploaded.url).origin;
    const kbUrl = `${base}/${KB_PATH}`;
    let existing: any[] = [];
    try {
      const res = await fetch(kbUrl, { cache: "no-store" });
      if (res.ok) existing = await res.json();
    } catch {}

    const seen = new Map<string, number[]>();
    for (const row of existing) seen.set(normalizeQ(row.question), row.embedding);
    const merged: any[] = [...existing];
    let processed = 0;

    for (let i = 0; i < parsed.length; i += BATCH) {
      const batch = parsed.slice(i, i + BATCH);
      const results = await Promise.all(batch.map(async r => {
        const key = normalizeQ(r.question);
        if (seen.has(key)) return { ...r, embedding: seen.get(key)! };
        const emb = await getEmbeddingSafe(r.question);
        return { ...r, embedding: emb };
      }));
      for (const r of results) {
        const k = normalizeQ(r.question);
        seen.set(k, r.embedding);
        const prev = merged.find(m => normalizeQ(m.question) === k);
        if (prev) {
          if (r.answer?.trim()) prev.answer = r.answer;
        } else merged.push(r);
      }
      processed += batch.length;
      console.log(`Embedded/merged ${processed}/${parsed.length}`);
    }

    const saved = await put(KB_PATH, JSON.stringify(merged, null, 2), {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json",
    });

    console.log(`✅ KB saved: ${saved.url}`);
    return NextResponse.json({ success: true, total: merged.length, kbUrl: saved.url });
  } catch (err: any) {
    console.error("INGEST_ERROR", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

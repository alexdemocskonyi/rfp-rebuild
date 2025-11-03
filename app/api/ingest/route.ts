import { NextResponse } from "next/server";
import { parseFile } from "../../../lib/documentParser";
import { loadKb, saveKb } from "../../../lib/kbStore";

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get("file") as File | null;
    if (!file) return NextResponse.json({ error: "No file uploaded" }, { status: 400 });

    const buffer = Buffer.from(await file.arrayBuffer());
    const entries = await parseFile(buffer, file.name);
    const kb = await loadKb();

    for (const e of entries) {
      if (e.question?.trim()) {
        kb.push({
          question: e.question.trim(),
          answers: [(e.answer ?? "").trim()].filter(Boolean),
          embedding: []
        });
      }
    }

    await saveKb(kb);
    return NextResponse.json({ success: true, added: entries.length });
  } catch (err: any) {
    console.error("Ingest error:", err);
    return NextResponse.json({ error: err.message || "Server error" }, { status: 500 });
  }
}

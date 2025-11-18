export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { loadKb, saveKb, sanitizeKb } from "@/lib/kb";

export async function POST(_req: NextRequest) {
  try {
    const kb = await loadKb();
    if (!Array.isArray(kb) || kb.length === 0) {
      return NextResponse.json(
        { ok: false, error: "KB empty or missing" },
        { status: 404 }
      );
    }

    const before = kb.length;
    const maybe = sanitizeKb(kb, {
      minAnswerLen: 8,
      useGPT: process.env.CLEAN_USE_GPT === "true",
      openaiKey: process.env.OPENAI_API_KEY,
    });

    const cleaned =
      (maybe as any)?.then ? await (maybe as Promise<any[]>) : (maybe as any[]);

    await saveKb(cleaned); // no-op if no blob write token available

    return NextResponse.json({
      ok: true,
      before,
      after: cleaned.length,
      removed: before - cleaned.length,
      writeMode: !!(
        process.env.BLOB_READ_WRITE_TOKEN || process.env.VERCEL_BLOB_READ_WRITE_TOKEN
      ),
    });
  } catch (err: any) {
    console.error("❌ KB_SANITIZE_ERROR", err);
    return NextResponse.json(
      { ok: false, error: err.message || "Unknown error" },
      { status: 500 }
    );
  }
}

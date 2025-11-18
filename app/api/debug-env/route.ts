
export const runtime = "nodejs";

import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ? "✅ set" : "❌ missing",
    BLOB_READ_WRITE_TOKEN: process.env.BLOB_READ_WRITE_TOKEN
      ? process.env.BLOB_READ_WRITE_TOKEN.slice(0, 30) + "..."
      : "❌ missing",
    BLOB_BASE_URL: process.env.BLOB_BASE_URL ?? "❌ missing",
  });
}

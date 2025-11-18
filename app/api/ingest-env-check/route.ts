export const runtime = "nodejs";

import { NextResponse } from "next/server";
export async function GET() {
  return NextResponse.json({
    BLOB_READ_WRITE_TOKEN: process.env.BLOB_READ_WRITE_TOKEN ?? null,
    BLOB_BASE_URL: process.env.BLOB_BASE_URL ?? null,
  });
}

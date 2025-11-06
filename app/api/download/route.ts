import { NextResponse } from "next/server";
import fs from "fs/promises";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const filePath = searchParams.get("path");
  if (!filePath) return NextResponse.json({ error: "Missing path" }, { status: 400 });

  try {
    const buffer = await fs.readFile(filePath);
    return new NextResponse(buffer, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": "attachment; filename=generated-report.docx",
      },
    });
  } catch (err: any) {
    console.error("DOWNLOAD_ERROR", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

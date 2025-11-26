// app/api/kb-update-answer/route.ts
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { getEmbedding } from "@/lib/embed";
import { updateOrInsertAnswer } from "@/lib/kb";

function norm(s: any) {
  return (s ?? "").toString().replace(/\s+/g, " ").trim();
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const questionRaw = norm(body.question);
    const answerRaw = norm(body.answer);
    const sourceRaw = body.source ? norm(body.source) : undefined;

    if (!questionRaw || !answerRaw) {
      return NextResponse.json(
        {
          ok: false,
          error: "Both `question` and `answer` are required.",
        },
        { status: 400 }
      );
    }

    console.log(
      "[KB-UPDATE-ANSWER] Updating answer for question:",
      questionRaw,
      "source:",
      sourceRaw || "(any)"
    );

    const embedding = await getEmbedding(questionRaw + "\n" + answerRaw);

    const updated = await updateOrInsertAnswer(
      questionRaw,
      answerRaw,
      sourceRaw,
      embedding
    );

    return NextResponse.json({
      ok: true,
      item: updated,
    });
  } catch (err: any) {
    console.error("❌ KB-UPDATE-ANSWER ERROR", err);
    return NextResponse.json(
      { ok: false, error: err.message || "Unknown error" },
      { status: 500 }
    );
  }
}

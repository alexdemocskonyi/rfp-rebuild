// app/api/chat/route.ts
import { NextResponse } from "next/server";
import OpenAI from "openai";
import { getEmbedding } from "@/lib/embed";
import { retrieveMatches } from "@/lib/kb";

export const runtime = "nodejs"; // Needs node for Buffer/fs in kb.ts
export const dynamic = "force-dynamic";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

async function fetchKB(): Promise<any[]> {
  try {
    const res = await fetch(
      "https://nwavns9phcxcbmyj.public.blob.vercel-storage.com/kb.json",
      { cache: "no-store" }
    );
    if (!res.ok) throw new Error(`KB fetch failed: ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error("KB_FETCH_ERROR", err);
    return [];
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const messages: ChatMessage[] = Array.isArray(body?.messages) ? body.messages : [];
    const model: string =
      typeof body?.model === "string" && body.model.trim()
        ? body.model.trim()
        : "gpt-4-turbo";

    if (!messages.length) {
      return NextResponse.json(
        { error: "Send { messages: [{ role, content }, ...] }" },
        { status: 400 }
      );
    }

    const userMsg = messages[messages.length - 1]?.content || "";
    if (!userMsg.trim()) {
      return NextResponse.json({ error: "Empty user message" }, { status: 400 });
    }

    // 1️⃣ Embed user query
    const embedding = await getEmbedding(userMsg);

    // 2️⃣ Retrieve semantic matches from KB
    const matches = await retrieveMatches(embedding, 5);
    const context = matches
      .map(
        (m, i) =>
          `Match ${i + 1}:\nQ: ${m.question}\nA: ${m.answer}`
      )
      .join("\n\n");

    // 3️⃣ Build augmented prompt
    const systemPrompt = `
You are the Uprise RFP knowledge assistant. 
Use the provided KB context to answer factually and concisely.
If the KB doesn’t contain relevant info, say “I don’t have that information in the RFP knowledge base.”
Always reference the KB context naturally in your reply when appropriate.
`;

    const chatMessages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: `User query:\n${userMsg}\n\nRelevant context:\n${context}` },
    ];

    // 4️⃣ Generate KB-aware response
    const completion = await openai.chat.completions.create({
      model,
      temperature: 0.3,
      max_tokens: 600,
      messages: chatMessages,
    });

    const reply = completion.choices?.[0]?.message?.content?.trim() ?? "";
    const usage = completion.usage ?? undefined;

    return NextResponse.json(
      {
        reply,
        model,
        contextMatches: matches.map((m) => ({
          question: m.question,
          score: m.score,
          source: m.source || "kb.json",
        })),
        usage,
      },
      { status: 200 }
    );
  } catch (err: any) {
    console.error("CHAT_API_ERROR", err);
    return NextResponse.json(
      { error: err?.message || "Unexpected error" },
      { status: 500 }
    );
  }
}

import OpenAI from "openai";
import { parseWorkbook } from "@/lib/parser";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

export async function analyzeDocument(buffer: Buffer, filename?: string) {
  const parsed = await parseWorkbook(buffer, filename);
  const contentPreview = JSON.stringify(parsed.slice(0, 10));

  const completion = await openai.chat.completions.create({
    model: "gpt-4-turbo",
    messages: [
      { role: "system", content: "Classify document type: Q&A, Narrative, or Hybrid RFP." },
      { role: "user", content: contentPreview }
    ]
  });

  const type = completion.choices[0].message.content?.trim() || "unknown";
  return { type, parsed };
}

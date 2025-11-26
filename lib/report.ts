// lib/report.ts

import OpenAI from "openai";
import { getEmbedding } from "@/lib/embed";
import { retrieveMatches } from "@/lib/kb";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

export async function generateReport(type: string, parsed: any[]) {
  if (type.toLowerCase().includes("q&a")) {
    const results = [];
    for (const row of parsed) {
      const q = row.question || row.Q || row.prompt;
      if (!q) continue;
      const embedding = await getEmbedding(q);
      const matches = await retrieveMatches(embedding, 5);
      const context = matches.map(m => `Q: ${m.question}\nA: ${m.answer}`).join("\n\n");

      const completion = await openai.chat.completions.create({
        model: "gpt-5",
        messages: [
          { role: "system", content: "You are a precise RFP answer synthesizer." },
          { role: "user", content: `Question: ${q}\n\nContext:\n${context}` }
        ]
      });

      results.push({
        question: q,
        final_answer: completion.choices[0].message.content,
        matches
      });
    }
    return { mode: "Q&A", results };
  }

  const fullText = parsed.map(p => Object.values(p).join(" ")).join("\n");
  const completion = await openai.chat.completions.create({
    model: "gpt-5",
    messages: [
      { role: "system", content: "You are an expert RFP analyst. Structure response clearly." },
      { role: "user", content: `Analyze this RFP content and produce a structured report.\n\n${fullText}` }
    ]
  });

  return {
    mode: "Narrative",
    report: completion.choices[0].message.content
  };
}

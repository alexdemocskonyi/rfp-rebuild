import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Compute embeddings using OpenAI's embeddings API. Uses the text-embedding-ada-002 model.
export async function getEmbedding(text: string): Promise<number[]> {
  const resp = await openai.embeddings.create({
    model: 'text-embedding-ada-002',
    input: text.replace(/\s+/g, ' ').trim(),
  });
  return resp.data[0].embedding;
}

// Classify each extracted entry as valid QA or garbage. This helps clean up the KB.
export async function classifyEntries(entries: { question: string; answer?: string | null }[]): Promise<boolean[]> {
  const prompt = `You are given a list of question-answer pairs extracted from various documents. For each pair, respond with "VALID" if the question appears meaningful and relevant and "GARBAGE" if it's not a real question (e.g., broken text, table headers, page numbers). Only reply with a JSON array of strings matching the number of pairs.`;
  const pairsText = entries.map((e, idx) => `(${idx + 1}) Q: ${e.question}\nA: ${e.answer || ''}`).join('\n\n');
  const userContent = `${prompt}\n\n${pairsText}`;
  const completion = await openai.chat.completions.create({
    model: 'gpt-4-turbo',
    messages: [
      { role: 'system', content: 'You are a helpful assistant that classifies entries.' },
      { role: 'user', content: userContent },
    ],
    temperature: 0,
  });
  const raw = completion.choices[0].message?.content?.trim() || '';
  let arr: string[];
  try {
    arr = JSON.parse(raw);
  } catch {
    // fallback: try to parse manually by splitting lines
    arr = raw.replace(/\[|\]|"/g, '').split(/[,\n]+/).map((s) => s.trim());
  }
  return arr.map((label) => label.toUpperCase().startsWith('VALID'));
}

// Given a list of candidate matches (existing Q/A from the KB) and the user's question,
// ask GPT-4 to pick the single best answer among them.
export async function selectBestAnswer(question: string, matches: { question: string; answers: string[] }[]): Promise<{ question: string; answer: string }> {
  const formatted = matches
    .map((m, i) => {
      return `Candidate ${i + 1}:\nQ: ${m.question}\nA: ${m.answers.join('\n')}`;
    })
    .join('\n\n');
  const userPrompt = `The user has asked: "${question}". You are given several candidate question-answer pairs that may help answer this question. Analyse which candidate best answers the user's question. Reply only with the number of the best candidate.`;
  const completion = await openai.chat.completions.create({
    model: 'gpt-4-turbo',
    messages: [
      { role: 'system', content: 'You are an expert at selecting the best matching answer.' },
      { role: 'assistant', content: formatted },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0,
  });
  const text = completion.choices[0].message?.content?.trim() || '';
  const idx = parseInt(text.match(/\d+/)?.[0] || '1', 10) - 1;
  const selected = matches[Math.max(0, Math.min(idx, matches.length - 1))];
  return { question: selected.question, answer: selected.answers.join('\n') };
}

// Synthesise a final answer using all relevant context. This uses retrieval augmented generation.
export async function synthesiseAnswer(question: string, context: { question: string; answers: string[] }[]): Promise<string> {
  const contextText = context
    .map((m) => `Q: ${m.question}\nA: ${m.answers.join('\n')}`)
    .join('\n\n');
  const prompt = `You are a proposal writer tasked with answering the following RFP question concisely and accurately. Use the provided context from your knowledge base to craft a coherent answer. Do not mention the context explicitly. If you cannot answer from the context, reply "I don't know".`;
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: prompt },
    { role: 'assistant', content: contextText },
    { role: 'user', content: question },
  ];
  const completion = await openai.chat.completions.create({
    model: 'gpt-4-turbo',
    messages,
    temperature: 0.2,
    max_tokens: 512,
  });
  return completion.choices[0].message?.content?.trim() || '';
}
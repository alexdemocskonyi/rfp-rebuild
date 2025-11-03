import { NextRequest, NextResponse } from 'next/server';
import { getEmbedding } from '../../../lib/openai';
import { loadKb } from '../../../lib/kbStore';


export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const query = (body.query || '').toString().trim();
    if (!query || query.length < 4) {
      return NextResponse.json({ error: 'Query must be at least 4 characters' }, { status: 400 });
    }
    // Compute embedding for the query
    const embedding = await getEmbedding(query);
    // Load knowledge base
    const kb = await loadKb();
    // Compute similarity (dot product) between query embedding and each item
    type Match = { question: string; answers: string[]; score: number };
    const matches: Match[] = kb.map((item) => {
      let score = 0;
      // dot product
      const minLength = Math.min(item.embedding.length, embedding.length);
      for (let i = 0; i < minLength; i++) {
        score += item.embedding[i] * embedding[i];
      }
      return { question: item.question, answers: item.answers, score };
    });
    // Sort descending by score and take top 5
    const topMatches = matches
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((m) => ({ question: m.question, answers: m.answers, score: m.score }));
    return NextResponse.json({ matches: topMatches }, { status: 200 });
  } catch (err: any) {
    console.error(err);
    return NextResponse.json({ error: err.message || 'Internal error' }, { status: 500 });
  }
}
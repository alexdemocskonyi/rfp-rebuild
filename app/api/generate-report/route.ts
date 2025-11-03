import { NextRequest, NextResponse } from 'next/server';
import { parseFile, QAEntry } from '../../../lib/documentParser';
import { getEmbedding } from '../../../lib/openai';
import { getFuzzyMatches, KBItem as FuzzyKBItem } from '../../../lib/fuzzyMatch';
import { selectBestAnswer, synthesiseAnswer } from '../../../lib/openai';
import { buildRfpReport, Section } from '../../../lib/reportBuilder';
import { loadKb } from '../../../lib/kbStore';

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file');
    if (!file || !(file instanceof File)) {
      return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
    }
    // Parse the RFP document to extract questions
    const buffer = Buffer.from(await (file as File).arrayBuffer());
    const entries: QAEntry[] = await parseFile(buffer, file.name);
    // Extract distinct questions
    const questions = entries
      .filter((e) => e.question && e.question.trim().length > 0)
      .map((e) => e.question.trim());
    // Load all KB items for fuzzy matching once
    const kbItems = await loadKb();
    const sections: Section[] = [];
    for (const q of questions) {
      // Compute embedding
      const embedding = await getEmbedding(q);
      // Top semantic matches
      // Compute similarity scores for semantic matches across KB
      const semanticMatches = (kbItems as any[]).map((item) => {
        let score = 0;
        const minLength = Math.min(item.embedding.length, embedding.length);
        for (let i = 0; i < minLength; i++) {
          score += item.embedding[i] * embedding[i];
        }
        return { question: item.question, answers: item.answers, score };
      });
      const semMatches = semanticMatches
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);
      // Fuzzy matches (use all kb items)
      const fuzzy = getFuzzyMatches(
        q,
        (kbItems as FuzzyKBItem[]).map((item) => ({ question: item.question, answers: item.answers })),
        3
      );
      // Convert fuzzy to same shape as semMatches
      const fuzzyMatches = fuzzy.map(({ item, score }) => ({ question: item.question, answers: item.answers, score }));
      // Best existing answer selected via GPT
      const best = await selectBestAnswer(q, semMatches);
      // Synthesise final answer
      const final = await synthesiseAnswer(q, semMatches);
      // Raw answers: compile top associated raw answers sorted by similarity score
      const rawAnswers: { question: string; answer: string }[] = [];
      semMatches.forEach((m: any) => {
        m.answers.forEach((ans: string) => {
          rawAnswers.push({ question: m.question, answer: ans });
        });
      });
      sections.push({
        question: q,
        semanticMatches: semMatches,
        fuzzyMatches,
        bestAnswer: best,
        finalAnswer: final,
        rawAnswers,
      });
    }
    // Build DOCX report
    const bufferDoc = await buildRfpReport(sections);
    const headers = new Headers();
    headers.set('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    headers.set('Content-Disposition', 'attachment; filename="rfp-response.docx"');
    return new NextResponse(bufferDoc, { status: 200, headers });
  } catch (err: any) {
    console.error(err);
    return NextResponse.json({ error: err.message || 'Failed to generate report' }, { status: 500 });
  }
}
import { Document, Packer, Paragraph, HeadingLevel, TextRun } from 'docx';

export interface Section {
  question: string;
  semanticMatches: { question: string; answers: string[]; score: number }[];
  fuzzyMatches: { question: string; answers: string[]; score: number }[];
  bestAnswer: { question: string; answer: string };
  finalAnswer: string;
  rawAnswers: { question: string; answer: string }[];
}

export async function buildRfpReport(sections: Section[]): Promise<Buffer> {
  const doc = new Document({
    creator: "RFP AI Agent",
    description: "Generated RFP response report",
    title: "RFP Response",
    sections: [{ children: [] }],
  });
  const children: Paragraph[] = [];
  sections.forEach((section, idx) => {
    // Question heading
    children.push(
      new Paragraph({
        text: `${idx + 1}. ${section.question}`,
        heading: HeadingLevel.HEADING_2,
        spacing: { after: 200 },
      })
    );
    // Top semantic matches
    children.push(
      new Paragraph({
        text: 'Top Semantic Matches:',
        heading: HeadingLevel.HEADING_3,
      })
    );
    section.semanticMatches.forEach((match, i) => {
      const preview = match.answers[0]?.split(/\n/).slice(0, 3).join('\n') || '';
      children.push(
        new Paragraph({
          children: [
            new TextRun({ text: `${i + 1}. Q: ${match.question}\n`, bold: true }),
            new TextRun({ text: `A: ${preview}` }),
          ],
        })
      );
    });
    // Top fuzzy matches
    children.push(
      new Paragraph({ text: 'Top Fuzzy Matches:', heading: HeadingLevel.HEADING_3 })
    );
    section.fuzzyMatches.forEach((match, i) => {
      const preview = match.answers[0]?.split(/\n/).slice(0, 3).join('\n') || '';
      children.push(
        new Paragraph({
          children: [
            new TextRun({ text: `${i + 1}. Q: ${match.question}\n`, bold: true }),
            new TextRun({ text: `A: ${preview}` }),
          ],
        })
      );
    });
    // AI-selected best existing answer
    children.push(
      new Paragraph({ text: 'Best Existing Answer:', heading: HeadingLevel.HEADING_3 })
    );
    children.push(
      new Paragraph({ text: section.bestAnswer.answer, spacing: { after: 200 } })
    );
    // AI-synthesised final answer
    children.push(
      new Paragraph({ text: 'Synthesised Final Answer:', heading: HeadingLevel.HEADING_3 })
    );
    children.push(
      new Paragraph({ text: section.finalAnswer, spacing: { after: 200 } })
    );
    // Raw answers (optional)
    children.push(
      new Paragraph({ text: 'Top Raw Answers:', heading: HeadingLevel.HEADING_3 })
    );
    section.rawAnswers.forEach((ra, i) => {
      children.push(
        new Paragraph({
          children: [
            new TextRun({ text: `${i + 1}. Q: ${ra.question}\n`, bold: true }),
            new TextRun({ text: `A: ${ra.answer}` }),
          ],
        })
      );
    });
    // Add spacing between questions
    children.push(new Paragraph({ text: '', spacing: { after: 400 } }));
  });
  (doc as any).Options.sections = [{ children }];
  const buffer = await Packer.toBuffer(doc);
  return buffer;
}
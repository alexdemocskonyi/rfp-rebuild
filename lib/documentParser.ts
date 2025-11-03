import * as pdfParse from "pdf-parse";
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export interface QAEntry {
  question: string;
  answer?: string | null;
}

// Determine file type based on mime type or extension
export async function parseFile(buffer: Buffer, fileName: string): Promise<QAEntry[]> {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.csv') || lower.endsWith('.tsv')) {
    return parseSpreadsheet(buffer, 'csv');
  }
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
    return parseSpreadsheet(buffer, 'xlsx');
  }
  if (lower.endsWith('.docx')) {
    return parseDocx(buffer);
  }
  if (lower.endsWith('.pdf')) {
    return parsePdf(buffer);
  }
  throw new Error('Unsupported file type');
}

// Parse CSV/XLSX and extract question/answer columns
async function parseSpreadsheet(buffer: Buffer, type: 'csv' | 'xlsx'): Promise<QAEntry[]> {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const json: any[] = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  // Determine question and answer column names
  const headerRow: string[] = Object.keys(json[0] || {});
  const questionKey = headerRow.find((key) => /^(q(uestion)?|prompt)/i.test(key)) || headerRow[0];
  const answerKey = headerRow.find((key) => /^(a(nswer)?|response)/i.test(key)) || headerRow[1];
  const entries: QAEntry[] = json.map((row) => {
    const question = String(row[questionKey] ?? '').trim();
    const answer = row[answerKey] !== undefined ? String(row[answerKey]).trim() : '';
    return { question, answer: answer || null };
  });
  return entries;
}

// Parse DOCX using mammoth
async function parseDocx(buffer: Buffer): Promise<QAEntry[]> {
  const { value } = await mammoth.extractRawText({ buffer });
  const text = value.trim();
  return extractQAUsingGPT(text);
}

// Parse PDF using pdf-parse
async function parsePdf(buffer: Buffer): Promise<QAEntry[]> {
  const data = await (pdfParse as any)(buffer);
  const text = data.text.trim();
  return extractQAUsingGPT(text);
}

// Ask GPT-4 to extract question-answer pairs from plain text. We ask for a JSON array of objects.
async function extractQAUsingGPT(text: string): Promise<QAEntry[]> {
  const systemPrompt =
    'You are a document parsing assistant. Given a raw document (which may include Q&A sections), extract all question and answer pairs. ' +
    'Return your response as JSON array of objects with the keys "question" and "answer". If an answer is missing, set it to an empty string. ' +
    'Ignore non-question text.';
  const completion = await openai.chat.completions.create({
    model: 'gpt-4-turbo',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: text.slice(0, 6000) },
    ],
    temperature: 0,
    max_tokens: 700,
  });
  const raw = completion.choices[0].message?.content?.trim() || '[]';
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr)
      ? arr.map((item) => ({ question: item.question?.trim() || '', answer: item.answer?.trim() || null }))
      : [];
  } catch (err) {
    console.error('Failed to parse extraction response', err, raw);
    return [];
  }
}
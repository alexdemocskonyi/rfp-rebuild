import stringSimilarity from 'string-similarity';

export interface KBItem {
  question: string;
  answers: string[];
}

export function getFuzzyMatches(query: string, items: KBItem[], count: number = 3): { item: KBItem; score: number }[] {
  if (!query || query.trim().length === 0) return [];
  const results = items.map((item) => {
    const score = stringSimilarity.compareTwoStrings(query.toLowerCase(), item.question.toLowerCase());
    return { item, score };
  });
  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, count);
}
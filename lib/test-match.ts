// lib/test-match.ts

import { getEmbedding } from "./embed";
import { retrieveMatches } from "./kb";

(async () => {
  console.log("🧪 Testing KB retrieval...");
  const testQ = "Describe the products and/or services and capabilities provided by your company.";
  const emb = await getEmbedding(testQ);
  console.log("Embedding length:", emb.length);
  const matches = await retrieveMatches(emb, 5);
  console.log("Top matches:", matches.map(m => ({ q: (m.question||"").slice(0,80), score: m.score?.toFixed(3) })));
})();

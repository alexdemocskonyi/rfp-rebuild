// scripts/clean-empty-answers.mjs
//
// One-time cleaner:
//   - Fetches kb.json from your Vercel blob
//   - Removes any entry with NO real answer (empty / whitespace)
//   - Writes kb-empty-pruned.json locally
//
// After running, upload kb-empty-pruned.json as kb.json in Vercel Blobs.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// --- config: your blob URL ---
const KB_URL =
  "https://ynyzmdodop38gqsz.public.blob.vercel-storage.com/kb.json";

// ESM __dirname shim
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function norm(s) {
  return (s ?? "").toString().replace(/\s+/g, " ").trim();
}

function hasRealAnswer(item) {
  const raw = item?.answer;
  const t = norm(raw);

  // "No answer" = missing, empty, or just nothing after trimming
  if (!t) return false;

  return true;
}

async function main() {
  console.log(`➡️  Fetching KB from: ${KB_URL}`);

  const res = await fetch(KB_URL);
  if (!res.ok) {
    console.error(`❌ Failed to fetch KB: HTTP ${res.status}`);
    process.exit(1);
  }

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    console.error("❌ Failed to parse kb.json as JSON");
    console.error(e);
    process.exit(1);
  }

  if (!Array.isArray(data)) {
    console.error("❌ kb.json is not an array");
    process.exit(1);
  }

  const original = data.length;

  const kept = data.filter((row) => hasRealAnswer(row));
  const removed = original - kept.length;

  console.log(`📊 Original rows : ${original}`);
  console.log(`🗑️  Removed (no answer) : ${removed}`);
  console.log(`✅ Remaining      : ${kept.length}`);

  const outPath = path.join(__dirname, "..", "kb-empty-pruned.json");
  await fs.writeFile(outPath, JSON.stringify(kept, null, 2), "utf8");
  console.log("");
  console.log(`💾 Wrote cleaned KB to: ${outPath}`);
  console.log("Next steps:");
  console.log("  1) Open Vercel → Storage → Blobs for this project");
  console.log("  2) Download existing kb.json as a backup (optional)");
  console.log("  3) Upload kb-empty-pruned.json and name it kb.json (overwrite existing)");
  console.log("  4) Re-run an RFP and verify behavior");
}

main().catch((err) => {
  console.error("❌ Unexpected error running cleaner:", err);
  process.exit(1);
});

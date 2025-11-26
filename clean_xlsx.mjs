import fs from "fs";
import * as XLSX from "xlsx";

const INPUT = "KB Master.xlsx";
const OUTPUT = "KB Master.cleaned.xlsx";

const norm = (s) => (s ?? "").toString().replace(/\s+/g, " ").trim();

const GARBAGE = [
  /^n\/a$/i, /^na$/i, /^none$/i, /^null$/i, /^tbd$/i,
  /^-+$/, /^not applicable$/i, /^[A-Za-z]$/,
  /^["']?[A-Za-z]?\W*$/, /lorem ipsum/i, /dummy/i,
  /sample text/i, /^\(?\s*200 words\s*\)?$/i
];

function isGarbageAnswer(a) {
  const t = norm(a);
  if (!t || t.length < 3) return true;
  return GARBAGE.some((rgx) => rgx.test(t));
}

function isEntitySpecific(question, answer) {
  const txt = (norm(question) + " " + norm(answer)).toLowerCase();

  if (/\b(this|the)\s+(rfp|rfi|rfq|solicitation|tender|bid|contract)\b/i.test(txt)) return true;
  if (/\bper\s+this\s+(rfp|rfi|rfq)\b/i.test(txt)) return true;
  if (/\b(rfp|rfi|rfq)\s*#?\s*\d{3,}\b/i.test(txt)) return true;

  if (/\bfor\s+the\s+(county|city|state|university|school district|board)\s+of\b/i.test(txt)) return true;
  if (/\bthe\s+(county|city|state)\s+of\s+[a-z]+\b/i.test(txt)) return true;
  if (/for\s+[A-Z][A-Za-z]+\s+County/i.test(txt)) return true;
  if (/for\s+the\s+City\s+of/i.test(txt)) return true;
  if (/for\s+the\s+State\s+of/i.test(txt)) return true;

  if (/we have [^.]*providers?[^.]*\b(northern|southern|eastern|western|region|county|city|state|area)\b/i
      .test(answer)) return true;

  if (/\bfor\s+your\s+(employees|members|population|organization|company)\b/i.test(txt)) return true;
  if (/\bwithin\s+your\s+(county|city|state|organization|company)\b/i.test(txt)) return true;

  return false;
}

function run() {
  if (!fs.existsSync(INPUT)) {
    console.error(`❌ File not found: ${INPUT}`);
    process.exit(1);
  }

  console.log(`📘 Loading workbook: ${INPUT}`);

  // ✅ ESM-safe: read manually and parse buffer
  const fileBuffer = fs.readFileSync(INPUT);
  const wb = XLSX.read(fileBuffer, { type: "buffer" });

  const outWb = XLSX.utils.book_new();

  for (const sheet of wb.SheetNames) {
    const ws = wb.Sheets[sheet];
    const json = XLSX.utils.sheet_to_json(ws, { defval: "" });
    const cleaned = [];

    if (!json.length) {
      XLSX.utils.book_append_sheet(outWb, XLSX.utils.aoa_to_sheet([]), sheet);
      continue;
    }

    const headers = Object.keys(json[0]);
    const qKey = headers.find((h) => /(question|prompt|rfp|item|inquiry|ask)/i.test(h)) || headers[0];
    const aKey =
      headers.find((h) => /(answer|response|details|explanation|description)/i.test(h)) ||
      headers.find((h) => h !== qKey) ||
      null;

    console.log(`📄 Sheet "${sheet}": Q="${qKey}", A="${aKey}"`);

    for (const row of json) {
      const q = norm(row[qKey]);
      const a = norm(row[aKey]);

      if (!q || !a) continue;
      if (isGarbageAnswer(a)) continue;
      if (isEntitySpecific(q, a)) continue;

      cleaned.push(row);
    }

    const outSheet = XLSX.utils.json_to_sheet(cleaned);
    XLSX.utils.book_append_sheet(outWb, outSheet, sheet);
  }

  XLSX.writeFile(outWb, OUTPUT);
  console.log(`✅ Cleaned Excel written to: ${OUTPUT}`);
}

run();

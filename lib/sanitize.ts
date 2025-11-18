// lib/sanitize.ts
export function sanitizeForDocx(input: any): string {
  const s = (input ?? "").toString();

  // Strip illegal XML chars
  let out = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");

  // Strip broken surrogate pairs
  out = out.replace(
    /([\uD800-\uDBFF])(?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])([\uDC00-\uDFFF])/g,
    ""
  );

  // *** CRITICAL: no redaction here ***
  // Do NOT remove "Uprise Health"
  // Do NOT call unifiedParser.redact()
  // Do NOT remove addresses or entity names

  return out.trim();
}

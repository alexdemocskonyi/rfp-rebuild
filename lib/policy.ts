// lib/policy.ts

// Basic normalizer for whitespace
function norm(s: any) {
  return (s ?? "").toString().replace(/\s+/g, " ").trim();
}

// 1) Normalize any bad/legacy location references → "Irvine, CA"
export function normalizeUpriseLocation(text: string): string {
  if (!text) return text;

  let out = text;

  // Kill known bad HQ references
  out = out.replace(/\bJupiter,\s*FL(?:orida)?\b/gi, "Irvine, CA");
  out = out.replace(/\bJupiter\s+Florida\b/gi, "Irvine, CA");

  // If it says Uprise is "headquartered in X", force it to Irvine, CA
  out = out.replace(
    /\b(headquarters?|hq|based|located)\b[^.]*\b(Uprise\s+Health)\b[^.]*\./gi,
    "Uprise Health is headquartered in Irvine, CA."
  );

  return out;
}

// 2) Remove/neutralize explicit personal names we know about,
//    and generally avoid individuals (without doing insane over-redaction)
export function removeIndividualNames(text: string): string {
  if (!text) return text;
  let out = text;

  // Hard-block known individuals
  out = out.replace(/Dr\.\s+Janis\s+S\.?\s+DiMonaco/gi, "[redacted]");
  out = out.replace(/Janis\s+S\.?\s+DiMonaco/gi, "[redacted]");
  out = out.replace(/Dr\.\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}/g, "Dr.");
  out = out.replace(
    /\b([A-Z][a-z]+)\s+([A-Z][a-z]+),\s*(CEO|CFO|COO|President|Chair|Director)\b/g,
    "$3"
  );

  // You *could* add a global "First Last" scrub here,
  // but we've seen how nasty that gets. I’d keep it scoped like above.

  return out;
}

// 3) Block female-ownership / leadership-gender answers
export function scrubFemaleOwnershipClaims(text: string): string {
  if (!text) return text;
  let out = text;

  // Any woman-owned / female-owned style claim → generic neutral statement
  out = out.replace(
    /\b(female|woman|women)[-\s]?owned\b[^.]*\./gi,
    "Ownership or leadership demographics are not provided in this context."
  );

  // Leadership gender stuff
  out = out.replace(
    /\b(female|woman|women)[-\s]?(CEO|CFO|founder|owner|leader|chair)\b[^.]*\./gi,
    "Leadership demographics are not provided in this context."
  );

  return out;
}

// Helpers to detect if a *question* is about these topics:
export function isFemaleOwnershipQuestion(q: string): boolean {
  const t = norm(q).toLowerCase();
  return /woman[-\s]?owned|female[-\s]?owned|minority[-\s]?owned|women[-\s]led|female[-\s]led/.test(
    t
  );
}

export function isLeadershipGenderQuestion(q: string): boolean {
  const t = norm(q).toLowerCase();
  return /(male|female|woman|women)\s+(ceo|cfo|founder|owner|leader|chair|executive)/.test(t);
}

export function isLocationQuestion(q: string): boolean {
  const t = norm(q).toLowerCase();
  return /(headquarters?|hq|where.*located|location of uprise|uprise health location)/.test(t);
}

// Master policy cleaner: run this on every final answer
export function applyUprisePolicy(question: string, answer: string): string {
  let a = norm(answer);

  // If the *question* directly asks about ownership or leadership gender,
  // override with a fixed, policy-safe response.
  if (isFemaleOwnershipQuestion(question) || isLeadershipGenderQuestion(question)) {
    return "Ownership and leadership demographics (including gender or minority status) are not provided; we encourage focusing on Uprise Health’s services and capabilities instead.";
  }

  // Hard-wire HQ / location answers to Irvine, CA
  if (isLocationQuestion(question)) {
    return "Uprise Health is headquartered in Irvine, CA.";
  }

  // Otherwise, just clean the text:
  a = normalizeUpriseLocation(a);
  a = scrubFemaleOwnershipClaims(a);
  a = removeIndividualNames(a);

  return a;
}

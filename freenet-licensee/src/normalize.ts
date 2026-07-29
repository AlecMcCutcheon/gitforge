/**
 * Content normalization aligned with licensee ContentHelper (wordset / Dice).
 */
const VARIETAL: Record<string, string> = {
  acknowledgment: "acknowledgement",
  analogue: "analog",
  analyse: "analyze",
  artefact: "artifact",
  authorisation: "authorization",
  authorised: "authorized",
  calibre: "caliber",
  cancelled: "canceled",
  capitalisations: "capitalizations",
  catalogue: "catalog",
  categorise: "categorize",
  centre: "center",
  emphasised: "emphasized",
  favour: "favor",
  favourite: "favorite",
  fulfil: "fulfill",
  fulfilment: "fulfillment",
  initialise: "initialize",
  judgment: "judgement",
  labelling: "labeling",
  labour: "labor",
  licence: "license",
  maximise: "maximize",
  modelled: "modeled",
  modelling: "modeling",
  offence: "offense",
  optimise: "optimize",
  organisation: "organization",
  organise: "organize",
  practise: "practice",
  programme: "program",
  realise: "realize",
  recognise: "recognize",
  signalise: "signalize",
  utilisation: "utilization",
  whilst: "while",
  wilful: "willful",
};

const FIELD_RE = /\[([a-z0-9_]+)\]/gi;
const COPYRIGHT_LINE =
  /(?:^|\n)[_\*\-\s]*(?:copyright|\(c\)|\u00a9).*?(?=\n|$)/gi;

export function normalizeLicenseText(raw: string): string {
  let s = raw.replace(/^\uFEFF/, "");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/^\s*#+\s*/gm, "");
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  s = s.replace(/[_*~]+(.*?)[_*~]+/g, "$1");
  s = s.replace(/^[*-](.*?)[*-]$/gm, "$1");
  s = s.replace(/^\s*>/gm, "");
  s = s.replace(/^[\s#*_]*end of (the )?terms and conditions[\s#*_]*$/gim, "");
  s = s.toLowerCase();
  s = s.replace(/http:/g, "https:");
  s = s.replace(/&/g, "and");
  s = s.replace(/(?<!^)([—–-]+)(?!$)/gm, "-");
  s = s.replace(/[`'"‘“’”]/g, "'");
  s = s.replace(/(\w+)-\s*\n\s*(\w+)/g, "$1-$2");
  s = s.replace(COPYRIGHT_LINE, " ");
  s = s.replace(/^\s*version.*$/gim, " ");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

export function wordsFromNormalized(normalized: string): string[] {
  const raw = normalized
    .split(/[^a-z0-9]+/i)
    .filter((w) => w.length > 0)
    .map((w) => VARIETAL[w] ?? w);
  return raw;
}

export function wordset(normalized: string): Set<string> {
  return new Set(wordsFromNormalized(normalized));
}

export function bigrams(normalized: string): Set<string> {
  const ws = wordsFromNormalized(normalized);
  const out = new Set<string>();
  for (let i = 0; i < ws.length - 1; i++) {
    out.add(`${ws[i]} ${ws[i + 1]}`);
  }
  return out;
}

export function fieldTokens(normalized: string): Set<string> {
  const out = new Set<string>();
  for (const m of normalized.matchAll(FIELD_RE)) {
    out.add(m[1]!.toLowerCase());
  }
  // also capture placeholder words like year fullname after brackets stripped oddly
  return out;
}

/** Dice-ish wordset similarity (0–100), licensee-shaped. */
export function wordsetSimilarity(
  licenseNorm: string,
  fileNorm: string,
): number {
  const licWords = wordset(licenseNorm);
  const fileWords = wordset(fileNorm);
  const fields = fieldTokens(licenseNorm);
  const licFieldless = new Set([...licWords].filter((w) => !fields.has(w)));
  const overlap = [...licFieldless].filter((w) => fileWords.has(w)).length;
  const total =
    licFieldless.size +
    fileWords.size -
    fields.size +
    Math.abs(licenseNorm.length - fileNorm.length) / 4;
  if (total <= 0) return 0;
  return (overlap * 200.0) / total;
}

export function bigramSimilarity(a: string, b: string): number {
  const ba = bigrams(a);
  const bb = bigrams(b);
  const total = ba.size + bb.size;
  if (total === 0) return 0;
  let overlap = 0;
  for (const x of ba) if (bb.has(x)) overlap++;
  return (overlap * 200.0) / total;
}

export const COPYRIGHT_ONLY_RE =
  /^(?:\s*(?:copyright|\(c\)|\u00a9|all rights reserved)[^\n]*\n?)+$/i;

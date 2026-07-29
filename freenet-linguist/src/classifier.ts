/**
 * Naive Bayes classifier — go-enry / Linguist samples frequencies.
 */
import { tokenize } from "./tokenizer";

export interface ClassifierDb {
  source: string;
  tokens_total: number;
  languages_log_probabilities: Record<string, number>;
  tokens_log_probabilities: Record<string, Record<string, number>>;
}

let cached: ClassifierDb | null = null;
let loading: Promise<ClassifierDb> | null = null;

/** Lazy-load the ~5MB classifier DB (separate Vite chunk). */
export async function ensureClassifier(): Promise<ClassifierDb> {
  if (cached) return cached;
  if (!loading) {
    loading = import("./generated/classifier.json").then((m) => {
      cached = (m as { default: ClassifierDb }).default ?? (m as unknown as ClassifierDb);
      return cached;
    });
  }
  return loading;
}

function tokenProbability(db: ClassifierDb, token: string, language: string): number {
  const byLang = db.tokens_log_probabilities[language];
  const p = byLang?.[token];
  if (p != null) return p;
  return Math.log(1.0 / db.tokens_total);
}

/**
 * Rank candidate languages by Naive Bayes score (highest first).
 * Matches go-enry's naiveBayes.classify.
 */
export function classifyContent(
  db: ClassifierDb,
  content: string | Uint8Array,
  candidates: string[],
): string[] {
  if (candidates.length === 0) return [];
  const empty =
    (typeof content === "string" ? content.length === 0 : content.byteLength === 0);
  const tokens = empty ? [] : tokenize(content);
  const scored: { language: string; score: number }[] = [];
  for (const language of candidates) {
    let score = db.languages_log_probabilities[language];
    if (score == null) continue;
    if (tokens.length > 0) {
      for (const tok of tokens) score += tokenProbability(db, tok, language);
    }
    scored.push({ language, score });
  }
  scored.sort((a, b) => b.score - a.score || a.language.localeCompare(b.language));
  return scored.map((s) => s.language);
}

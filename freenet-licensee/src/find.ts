/**
 * Score root paths for likely license files (licensee LicenseFile FILENAME_REGEXES).
 */

const PREFERRED_EXT = /\.(md|markdown|txt|html)$/i;

export interface ScoredPath {
  path: string;
  basename: string;
  score: number;
}

function scoreBasename(name: string): number {
  const n = name;
  if (/^(un)?licen[sc]e$/i.test(n)) return 1.0;
  if (/^(un)?licen[sc]e\.(md|markdown|txt|html)$/i.test(n)) return 0.95;
  if (/^copying$/i.test(n)) return 0.9;
  if (/^copying\.(md|markdown|txt|html)$/i.test(n)) return 0.85;
  if (/^(un)?licen[sc]e\./i.test(n)) return 0.8;
  if (/^copying\./i.test(n)) return 0.75;
  if (/^(un)?licen[sc]e[-_]/i.test(n)) return 0.7;
  if (/^copying[-_]/i.test(n)) return 0.65;
  if (/[-_](un)?licen[sc]e/i.test(n)) return 0.6;
  if (/^ofl(\.|$)/i.test(n)) return PREFERRED_EXT.test(n) ? 0.5 : 0.4;
  if (/^copyright$/i.test(n)) return 0.35;
  if (/^copyright\.(md|markdown|txt|html)$/i.test(n)) return 0.3;
  if (/^copyright/i.test(n)) return 0.2;
  if (/^patents$/i.test(n)) return 0.15;
  return 0;
}

/** Best-scoring license-like files under repo root (and LICENSES/). */
export function findLicenseCandidates(paths: string[]): ScoredPath[] {
  const scored: ScoredPath[] = [];
  for (const path of paths) {
    const norm = path.replace(/\\/g, "/").replace(/^\.\//, "");
    const parts = norm.split("/");
    if (parts.length === 1) {
      const score = scoreBasename(parts[0]!);
      if (score > 0) scored.push({ path: norm, basename: parts[0]!, score });
      continue;
    }
    if (
      parts.length === 2 &&
      parts[0]!.toLowerCase() === "licenses" &&
      PREFERRED_EXT.test(parts[1]!)
    ) {
      scored.push({ path: norm, basename: parts[1]!, score: 1.0 });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return scored;
}

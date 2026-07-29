/**
 * Content heuristics from Linguist heuristics.yml (disambiguation rules).
 */
import heuristicsJson from "./generated/heuristics.json";
import { compileLinguistRegex } from "./ruby-regex";

interface HeuristicRule {
  language?: string | string[];
  pattern?: string | string[];
  negative_pattern?: string | string[];
  named_pattern?: string;
  and?: HeuristicRule[];
}

interface Disambiguation {
  extensions: string[];
  rules: HeuristicRule[];
}

interface HeuristicsFile {
  named_patterns?: Record<string, string | string[]>;
  disambiguations: Disambiguation[];
}

const data = heuristicsJson as HeuristicsFile;

function toRegex(pat: string | string[]): RegExp | null {
  if (Array.isArray(pat)) {
    const parts = pat
      // OLD CODE - KEEP UNTIL CONFIRMED WORKING
      // .map((p) => compileLinguistRegex(p))
      // NEW CODE - TESTING: Ruby ^/$ are line anchors — JS needs `m`
      .map((p) => compileLinguistRegex(p, "m"))
      .filter((r): r is RegExp => r != null);
    if (parts.length === 0) return null;
    // Rebuild as alternation with merged flags (prefer i/m if any part had them)
    const flags = new Set<string>();
    for (const r of parts) for (const f of r.flags) flags.add(f);
    flags.add("m");
    const body = parts.map((r) => `(?:${r.source})`).join("|");
    try {
      return new RegExp(body, [...flags].join(""));
    } catch {
      return null;
    }
  }
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // return compileLinguistRegex(pat);
  // NEW CODE - TESTING: multiline so .rs Rust rule matches after //! comments
  return compileLinguistRegex(pat, "m");
}

type Matcher = (input: string) => boolean;

function compileRule(
  named: Record<string, Matcher>,
  rule: HeuristicRule,
): Matcher {
  if (rule.and) {
    const parts = rule.and.map((r) => compileRule(named, r));
    return (input) => parts.every((p) => p(input));
  }
  if (rule.pattern != null) {
    const re = toRegex(rule.pattern);
    if (!re) return () => false;
    return (input) => {
      try {
        return re.test(input);
      } catch {
        return false;
      }
    };
  }
  if (rule.negative_pattern != null) {
    const re = toRegex(rule.negative_pattern);
    if (!re) return () => false;
    return (input) => {
      try {
        return !re.test(input);
      } catch {
        return false;
      }
    };
  }
  if (rule.named_pattern != null) {
    return named[rule.named_pattern] ?? (() => true);
  }
  return () => true;
}

interface CompiledHeuristic {
  extensions: string[];
  rules: { languages: string[]; match: Matcher }[];
}

const namedMatchers: Record<string, Matcher> = {};
for (const [k, v] of Object.entries(data.named_patterns ?? {})) {
  const re = toRegex(v);
  namedMatchers[k] = re
    ? (input) => {
        try {
          return re.test(input);
        } catch {
          return false;
        }
      }
    : () => false;
}

const heuristics: CompiledHeuristic[] = (data.disambiguations ?? []).map((d) => ({
  extensions: d.extensions.map((e) => e.toLowerCase()),
  rules: d.rules.map((r) => {
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // language: r.language, match: compileRule(namedMatchers, r)
    // — Linguist's .rs Rust pattern missed `struct`/`pub(`/`const`/… so the
    // Bayes step (or extension[0]=RenderScript) flipped huge Rust trees.
    // NEW CODE - TESTING: widen Rust .rs rule locally (upstream is too narrow)
    let rule: HeuristicRule = r;
    if (
      d.extensions.map((e) => e.toLowerCase()).includes(".rs") &&
      r.language === "Rust" &&
      typeof r.pattern === "string"
    ) {
      rule = {
        ...r,
        pattern:
          "^(use |fn |mod |pub |macro_rules|impl|#!?\\[|struct |enum |trait |type |const |static |let |async\\s+fn|pub\\()",
      };
    }
    return {
      languages: Array.isArray(rule.language)
        ? rule.language
        : rule.language
          ? [rule.language]
          : [],
      match: compileRule(namedMatchers, rule),
    };
  }),
}));

const HEURISTICS_BYTES = 50 * 1024;

function extOf(path: string): string {
  const base = path.replace(/\\/g, "/").split("/").pop() ?? "";
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i).toLowerCase() : "";
}

/**
 * Apply Linguist heuristics for this path’s extension.
 * Returns matched rule languages (Linguist does not intersect here),
 * or [] if no heuristic / no match — outer detect keeps prior candidates.
 */
export function applyHeuristics(
  path: string,
  content: string | Uint8Array,
  candidates: string[],
): string[] {
  void candidates;
  const ext = extOf(path);
  if (!ext) return [];
  const text =
    typeof content === "string"
      ? content.slice(0, HEURISTICS_BYTES)
      : new TextDecoder("utf-8", { fatal: false }).decode(
          content.subarray(0, Math.min(content.byteLength, HEURISTICS_BYTES)),
        );

  for (const h of heuristics) {
    if (!h.extensions.includes(ext)) continue;
    for (const rule of h.rules) {
      if (!rule.match(text)) continue;
      return rule.languages;
    }
    return [];
  }
  return [];
}

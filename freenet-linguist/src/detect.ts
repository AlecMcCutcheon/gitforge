/**
 * Full language detection pipeline — Linguist STRATEGIES order
 * (via go-enry-compatible Naive Bayes classifier data).
 *
 * Outer loop matches linguist.rb: empty strategy result keeps prior
 * candidates; non-empty replaces (strategies intersect internally).
 */
import { isBinaryContent } from "./binary";
import {
  classifyContent,
  ensureClassifier,
  type ClassifierDb,
} from "./classifier";
import {
  catalog,
  classifyPath,
  isDocumentationPath,
  isVendoredPath,
} from "./classify";
import { isGenerated } from "./generated";
import {
  attrsForPath,
  type GitattributesRules,
} from "./gitattributes";
import { applyHeuristics } from "./heuristics";
import { languageByAlias } from "./strategies";
import {
  strategyExtension,
  strategyFilename,
  strategyManpage,
  strategyModeline,
  strategyShebang,
  strategyXml,
} from "./strategies";

export interface DetectOptions {
  gitattributes?: GitattributesRules | null;
  /** Preloaded classifier (else lazy-loaded). */
  classifier?: ClassifierDb | null;
}

/**
 * Detect language for one file (Linguist/enry strategy funnel).
 * Returns canonical language name or null.
 */
export function detectLanguage(
  path: string,
  content: string | Uint8Array | null | undefined,
  opts: DetectOptions = {},
): string | null {
  const norm = path.replace(/\\/g, "/");
  const attrs = attrsForPath(opts.gitattributes, norm);
  if (attrs.language) {
    return languageByAlias(attrs.language) ?? attrs.language;
  }
  if (attrs.vendored === true || attrs.generated === true) return null;
  if (attrs.documentation === true) return null;

  if (isVendoredPath(norm) || isDocumentationPath(norm)) return null;
  if (isGenerated(norm, content ?? null)) return null;
  if (content != null && isBinaryContent(content)) return null;

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const body = content ?? new Uint8Array();
  // …then strategyExtension → [RenderScript, Rust, XML] and with null
  // content we fell through to `languages[0]` = RenderScript, flipping the
  // path-only Rust paint after the content/null refine pass.
  // NEW CODE - TESTING: treat empty as no content; prefer classifyPath
  // (popularity) when ambiguous without bytes.
  const hasBytes =
    content != null &&
    (typeof content === "string"
      ? content.length > 0
      : content.byteLength > 0);
  const body = hasBytes
    ? content!
    : new Uint8Array();

  let languages: string[] = [];

  const step = (next: string[]): string | null => {
    // Linguist: empty → keep prior; non-empty → replace
    if (next.length === 0) return null;
    languages = next;
    return languages.length === 1 ? languages[0]! : null;
  };

  let hit =
    step(strategyModeline(body)) ??
    step(strategyFilename(norm, languages)) ??
    step(strategyShebang(body, languages)) ??
    step(strategyExtension(norm, languages)) ??
    step(strategyXml(body, languages)) ??
    step(strategyManpage(norm, languages));

  if (hit) return hit;

  if (hasBytes) {
    hit = step(applyHeuristics(norm, content!, languages));
    if (hit) return hit;
  }

  if (languages.length === 1) return languages[0]!;

  if (languages.length > 1 && opts.classifier && hasBytes) {
    const ranked = classifyContent(opts.classifier, content!, languages);
    return ranked[0] ?? languages[0]!;
  }

  if (languages.length > 1) {
    const pathPick = classifyPath(norm);
    if (pathPick && languages.includes(pathPick.name)) {
      return pathPick.name;
    }
  }

  return languages[0] ?? null;
}

/** Async detect that ensures the classifier DB is loaded. */
export async function detectLanguageAsync(
  path: string,
  content: string | Uint8Array | null | undefined,
  opts: Omit<DetectOptions, "classifier"> = {},
): Promise<string | null> {
  const classifier = await ensureClassifier();
  return detectLanguage(path, content, { ...opts, classifier });
}

export function languageType(name: string): string | null {
  return catalog.languages[name]?.type ?? null;
}

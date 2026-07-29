import { ensureClassifier } from "./classifier";
import {
  catalog,
  classifyPath,
  isDocumentationPath,
  isVendoredPath,
  languageColor,
  statsLanguageName,
} from "./classify";
import { detectLanguage } from "./detect";
import type { GitattributesRules } from "./gitattributes";
import { attrsForPath } from "./gitattributes";
import { isGenerated } from "./generated";
import type { ClassifierDb } from "./classifier";
import type { LanguageBreakdown, LanguageSlice, PathSize } from "./types";

export interface AnalyzeFile extends PathSize {
  /** UTF-8 text or raw bytes (needed for full Linguist parity). */
  content?: string | Uint8Array | null;
}

export interface AnalyzeOptions {
  /** Include data/prose languages (default false — matches GitHub bar). */
  includeDataAndProse?: boolean;
  gitattributes?: GitattributesRules | null;
  classifier?: ClassifierDb | null;
  /** Progressive UI: called with a cheap path-only breakdown first. */
  onPartial?: (breakdown: LanguageBreakdown) => void;
  signal?: AbortSignal;
}

function yieldToMain(): Promise<void> {
  return new Promise((resolve) => {
    const sch = (
      globalThis as {
        scheduler?: { yield?: () => Promise<void> };
      }
    ).scheduler;
    if (typeof sch?.yield === "function") {
      void sch.yield().then(resolve);
      return;
    }
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(() => resolve(), { timeout: 32 });
      return;
    }
    setTimeout(resolve, 0);
  });
}

function finishBreakdown(
  bytesByLang: Map<string, number>,
  skipped: number,
  totalBytes: number,
): LanguageBreakdown {
  const languages: LanguageSlice[] = [...bytesByLang.entries()]
    .map(([name, bytes]) => ({
      name,
      color: languageColor(name),
      bytes,
      percent: totalBytes > 0 ? (bytes / totalBytes) * 100 : 0,
    }))
    .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
  return { totalBytes, languages, skipped };
}

function shouldSkipPath(
  path: string,
  attrs: ReturnType<typeof attrsForPath>,
): boolean {
  if (
    attrs.vendored === true ||
    attrs.generated === true ||
    attrs.documentation === true
  ) {
    return true;
  }
  if (attrs.detectable === false) return true;
  if (isVendoredPath(path) || isDocumentationPath(path)) return true;
  return false;
}

/** Cheap first paint — filename/extension only (no content / classifier). */
export function analyzeFilesPathOnly(
  files: AnalyzeFile[],
  opts: AnalyzeOptions = {},
): LanguageBreakdown {
  return analyzePathOnly(files, opts);
}

/** Cheap first paint — filename/extension only (no content / classifier). */
function analyzePathOnly(
  files: AnalyzeFile[],
  opts: AnalyzeOptions,
): LanguageBreakdown {
  const bytesByLang = new Map<string, number>();
  let skipped = 0;
  let totalBytes = 0;

  for (const file of files) {
    const size = Math.max(0, Number(file.size) || 0);
    if (size === 0) {
      skipped += 1;
      continue;
    }
    const path = file.path.replace(/\\/g, "/");
    const attrs = attrsForPath(opts.gitattributes, path);
    if (shouldSkipPath(path, attrs)) {
      skipped += 1;
      continue;
    }
    if (isGenerated(path, null)) {
      skipped += 1;
      continue;
    }

    const def = classifyPath(path);
    if (!def) {
      skipped += 1;
      continue;
    }
    if (
      !opts.includeDataAndProse &&
      (def.type === "data" || def.type === "prose") &&
      attrs.detectable !== true
    ) {
      skipped += 1;
      continue;
    }
    const rollup = statsLanguageName(def);
    bytesByLang.set(rollup, (bytesByLang.get(rollup) ?? 0) + size);
    totalBytes += size;
  }

  return finishBreakdown(bytesByLang, skipped, totalBytes);
}

function analyzeWithClassifier(
  files: AnalyzeFile[],
  opts: AnalyzeOptions,
): LanguageBreakdown {
  const bytesByLang = new Map<string, number>();
  let skipped = 0;
  let totalBytes = 0;

  for (const file of files) {
    const size = Math.max(0, Number(file.size) || 0);
    if (size === 0) {
      skipped += 1;
      continue;
    }
    const path = file.path.replace(/\\/g, "/");
    const attrs = attrsForPath(opts.gitattributes, path);
    if (
      attrs.vendored === true ||
      attrs.generated === true ||
      attrs.documentation === true
    ) {
      skipped += 1;
      continue;
    }
    if (attrs.detectable === false) {
      skipped += 1;
      continue;
    }

    const name = detectLanguage(path, file.content ?? null, {
      gitattributes: opts.gitattributes,
      classifier: opts.classifier ?? null,
    });
    if (!name) {
      skipped += 1;
      continue;
    }
    const def = catalog.languages[name];
    if (
      def &&
      !opts.includeDataAndProse &&
      (def.type === "data" || def.type === "prose")
    ) {
      if (attrs.detectable !== true) {
        skipped += 1;
        continue;
      }
    }
    const rollup = def ? statsLanguageName(def) : name;
    bytesByLang.set(rollup, (bytesByLang.get(rollup) ?? 0) + size);
    totalBytes += size;
  }

  return finishBreakdown(bytesByLang, skipped, totalBytes);
}

/**
 * Sync analyze — Bayes step only if `opts.classifier` is set.
 */
export function analyzeFiles(
  files: AnalyzeFile[],
  opts: AnalyzeOptions = {},
): LanguageBreakdown {
  return analyzeWithClassifier(files, opts);
}

const CHUNK = 32;

/**
 * Full analyze: path-only partial → yield → load classifier → chunked detect.
 * Keeps the UI thread responsive (skeletons / interactions).
 */
export async function analyzeFilesAsync(
  files: AnalyzeFile[],
  opts: AnalyzeOptions = {},
): Promise<LanguageBreakdown> {
  const partial = analyzePathOnly(files, opts);
  opts.onPartial?.(partial);
  if (opts.signal?.aborted) return partial;

  await yieldToMain();
  if (opts.signal?.aborted) return partial;

  const classifier = opts.classifier ?? (await ensureClassifier());
  await yieldToMain();
  if (opts.signal?.aborted) return partial;

  const bytesByLang = new Map<string, number>();
  let skipped = 0;
  let totalBytes = 0;

  for (let i = 0; i < files.length; i++) {
    if (i > 0 && i % CHUNK === 0) {
      await yieldToMain();
      if (opts.signal?.aborted) {
        return finishBreakdown(bytesByLang, skipped, totalBytes);
      }
    }

    const file = files[i]!;
    const size = Math.max(0, Number(file.size) || 0);
    if (size === 0) {
      skipped += 1;
      continue;
    }
    const path = file.path.replace(/\\/g, "/");
    const attrs = attrsForPath(opts.gitattributes, path);
    if (
      attrs.vendored === true ||
      attrs.generated === true ||
      attrs.documentation === true
    ) {
      skipped += 1;
      continue;
    }
    if (attrs.detectable === false) {
      skipped += 1;
      continue;
    }

    const name = detectLanguage(path, file.content ?? null, {
      gitattributes: opts.gitattributes,
      classifier,
    });
    if (!name) {
      skipped += 1;
      continue;
    }
    const def = catalog.languages[name];
    if (
      def &&
      !opts.includeDataAndProse &&
      (def.type === "data" || def.type === "prose")
    ) {
      if (attrs.detectable !== true) {
        skipped += 1;
        continue;
      }
    }
    const rollup = def ? statsLanguageName(def) : name;
    bytesByLang.set(rollup, (bytesByLang.get(rollup) ?? 0) + size);
    totalBytes += size;
  }

  return finishBreakdown(bytesByLang, skipped, totalBytes);
}

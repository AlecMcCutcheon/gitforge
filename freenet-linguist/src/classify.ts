import type { LanguageDef, LanguageType, LinguistCatalog } from "./types";
import catalogJson from "./generated/catalog.json";
import { compileLinguistRegex } from "./ruby-regex";

export const catalog = catalogJson as LinguistCatalog;

const compiledVendor: RegExp[] = catalog.vendor_patterns
  .map((p) => compileLinguistRegex(p, "i"))
  .filter((r): r is RegExp => r != null);
const compiledDocs: RegExp[] = catalog.documentation_patterns
  .map((p) => compileLinguistRegex(p, "i"))
  .filter((r): r is RegExp => r != null);

/** Common binary / non-source extensions (path-only; no content sniff yet). */
const BINARY_EXT = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".bmp",
  ".pdf",
  ".zip",
  ".gz",
  ".tgz",
  ".bz2",
  ".xz",
  ".7z",
  ".rar",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".mp3",
  ".mp4",
  ".webm",
  ".wav",
  ".ogg",
  ".wasm",
  ".so",
  ".dylib",
  ".dll",
  ".exe",
  ".o",
  ".a",
  ".class",
  ".jar",
  ".pyc",
  ".pyo",
  ".db",
  ".sqlite",
  ".sqlite3",
]);

function basename(path: string): string {
  const norm = path.replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  return i >= 0 ? norm.slice(i + 1) : norm;
}

function extensionOf(base: string): string | null {
  const lower = base.toLowerCase();
  // multi-dot: prefer longest known extension later via index; take last .foo
  const dot = lower.lastIndexOf(".");
  if (dot <= 0) return null;
  return lower.slice(dot);
}

export function isVendoredPath(path: string): boolean {
  const p = path.replace(/\\/g, "/");
  return compiledVendor.some((re) => re.test(p));
}

export function isDocumentationPath(path: string): boolean {
  const p = path.replace(/\\/g, "/");
  return compiledDocs.some((re) => re.test(p));
}

export function isLikelyBinaryPath(path: string): boolean {
  const ext = extensionOf(basename(path));
  return Boolean(ext && BINARY_EXT.has(ext));
}

const popularRank = new Map<string, number>(
  (catalog.popular ?? []).map((name, i) => [name, i]),
);

const TYPE_RANK: Record<LanguageType, number> = {
  programming: 0,
  markup: 1,
  data: 2,
  prose: 3,
};

/**
 * Pick one language when several share an extension/filename.
 * Prefer programming > markup > data > prose; then primary extension;
 * then Linguist popular.yml; then name.
 */
function pickCandidate(
  names: string[],
  extOrFile: string,
  kind: "ext" | "file",
): LanguageDef | null {
  const defs = names
    .map((n) => catalog.languages[n])
    .filter((d): d is LanguageDef => Boolean(d));
  if (defs.length === 0) return null;
  if (defs.length === 1) return defs[0]!;

  defs.sort((a, b) => {
    const tr = TYPE_RANK[a.type] - TYPE_RANK[b.type];
    if (tr !== 0) return tr;
    if (kind === "ext") {
      const ai = a.extensions.map((e) => e.toLowerCase()).indexOf(extOrFile);
      const bi = b.extensions.map((e) => e.toLowerCase()).indexOf(extOrFile);
      const aPri = ai < 0 ? 99 : ai;
      const bPri = bi < 0 ? 99 : bi;
      if (aPri !== bPri) return aPri - bPri;
    }
    const ap = popularRank.get(a.name) ?? 10_000;
    const bp = popularRank.get(b.name) ?? 10_000;
    if (ap !== bp) return ap - bp;
    return a.name.localeCompare(b.name);
  });
  return defs[0]!;
}

/**
 * Classify a path using filename then extension (Linguist strategies subset).
 * Returns null when unknown / not classified.
 */
export function classifyPath(path: string): LanguageDef | null {
  const base = basename(path);
  const baseLower = base.toLowerCase();

  const byName = catalog.filename_index[baseLower];
  if (byName?.length) {
    return pickCandidate(byName, baseLower, "file");
  }

  const ext = extensionOf(base);
  if (ext) {
    const byExt = catalog.extension_index[ext];
    if (byExt?.length) return pickCandidate(byExt, ext, "ext");
  }
  return null;
}

/**
 * True when shebang/heuristics/classifier may need blob bytes.
 * Unique filename/extension hits can skip content for language stats.
 */
export function pathDetectionNeedsContent(path: string): boolean {
  const base = basename(path);
  const baseLower = base.toLowerCase();
  const byName = catalog.filename_index[baseLower];
  if (byName?.length === 1) return false;
  if (byName && byName.length > 1) return true;
  const ext = extensionOf(base);
  if (!ext) return true;
  const byExt = catalog.extension_index[ext];
  if (!byExt?.length) return true;
  return byExt.length > 1;
}

/** Stats rollup name (Linguist `group` parent when set). */
export function statsLanguageName(def: LanguageDef): string {
  return def.group && catalog.languages[def.group] ? def.group : def.name;
}

export function languageColor(name: string): string | null {
  return catalog.languages[name]?.color ?? null;
}

import { getLicense, catalog } from "./catalog";
import {
  bigramSimilarity,
  COPYRIGHT_ONLY_RE,
  fieldTokens,
  normalizeLicenseText,
  wordset,
  wordsetSimilarity,
} from "./normalize";
import { findLicenseCandidates } from "./find";
import type { DetectResult, PathContent } from "./types";

const CONFIDENCE = 98;

function matchCopyright(content: string): boolean {
  const t = content.trim();
  if (!t) return false;
  return COPYRIGHT_ONLY_RE.test(t);
}

function detectOne(content: string): Omit<DetectResult, "path"> {
  if (matchCopyright(content)) {
    return {
      key: "no-license",
      spdxId: null,
      title: "No License",
      confidence: 100,
      matcher: "copyright",
    };
  }

  const fileNorm = normalizeLicenseText(content);
  const fileWords = wordset(fileNorm);

  // Exact wordset (ignore template field tokens on the license side)
  for (const lic of Object.values(catalog.licenses)) {
    const licNorm = normalizeLicenseText(lic.content);
    const fields = fieldTokens(licNorm);
    const licSet = new Set(
      [...wordset(licNorm)].filter((w) => !fields.has(w)),
    );
    const fileSet = new Set(
      [...fileWords].filter((w) => !/^\d{4}$/.test(w)),
    );
    // allow year digits in file by comparing after removing years from file for exact? 
    // Prefer dice for filled licenses; exact for pristine templates
    if (licSet.size > 0 && setsEqual(licSet, fileWords)) {
      return {
        key: lic.key,
        spdxId: lic.spdx_id,
        title: lic.title,
        confidence: 100,
        matcher: "exact",
      };
    }
    void fileSet;
  }

  // Dice
  let best: { key: string; sim: number; title: string; spdx: string | null } | null =
    null;
  for (const lic of Object.values(catalog.licenses)) {
    if (lic.key.startsWith("cc-") && /attribution-(noncommercial|noderiv)/i.test(content)) {
      continue;
    }
    const licNorm = normalizeLicenseText(lic.content);
    const sim = wordsetSimilarity(licNorm, fileNorm);
    if (sim < CONFIDENCE) continue;
    const bi = bigramSimilarity(licNorm, fileNorm);
    if (bi < CONFIDENCE / 2) continue;
    if (!best || sim > best.sim) {
      best = {
        key: lic.key,
        sim,
        title: lic.title,
        spdx: lic.spdx_id,
      };
    }
  }
  if (best) {
    return {
      key: best.key,
      spdxId: best.spdx,
      title: best.title,
      confidence: best.sim,
      matcher: "dice",
    };
  }

  return {
    key: null,
    spdxId: null,
    title: null,
    confidence: 0,
    matcher: null,
  };
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/**
 * Detect project license from tip files (path + content).
 * Picks highest-scoring license filename, then runs Copyright → Exact → Dice.
 */
export function detectLicense(files: PathContent[]): DetectResult {
  const byPath = new Map(
    files.map((f) => [f.path.replace(/\\/g, "/"), f.content]),
  );
  const candidates = findLicenseCandidates([...byPath.keys()]);
  for (const c of candidates) {
    const content = byPath.get(c.path);
    if (content == null || !content.trim()) continue;
    const hit = detectOne(content);
    if (hit.matcher === "copyright") {
      // keep looking for a real license file
      continue;
    }
    if (hit.key) {
      return { ...hit, path: c.path };
    }
  }
  // copyright-only fallback
  for (const c of candidates) {
    const content = byPath.get(c.path);
    if (content == null) continue;
    const hit = detectOne(content);
    if (hit.matcher === "copyright") {
      return { ...hit, path: c.path };
    }
  }
  return {
    key: null,
    spdxId: null,
    title: null,
    confidence: 0,
    matcher: null,
    path: candidates[0]?.path ?? null,
  };
}

export function licenseTabLabel(result: DetectResult): string {
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // Prefer long choosealicense title ("MIT License", "GNU Lesser…")
  // NEW CODE - TESTING: GitHub tab uses short SPDX id ("MIT license", "LGPL-3.0 license")
  if (result.spdxId) return `${result.spdxId} license`;
  if (result.key && result.key !== "no-license") {
    return `${result.key.toUpperCase()} license`;
  }
  if (result.title) {
    const t = result.title;
    return /license$/i.test(t) ? t : `${t} license`;
  }
  return "License";
}

export { getLicense };

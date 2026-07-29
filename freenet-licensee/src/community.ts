/**
 * Discover community-health file paths (GitHub soft-support rules).
 * See docs/community-files.md.
 */
import type { CommunityFiles } from "./types";

const DIRS = [".github", "", "docs"] as const;

function baseNames(kind: string): string[] {
  const k = kind.toUpperCase();
  return [
    `${k}.md`,
    k,
    `${k}.txt`,
    `${k}.markdown`,
    // hyphenated variants
    `${k.replace(/_/g, "-")}.md`,
    k.replace(/_/g, "-"),
  ];
}

function findInDirs(
  pathSet: Set<string>,
  kind: string,
  dirs: readonly string[],
): string | null {
  const names = baseNames(kind);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = dir ? `${dir}/${name}` : name;
      // case-insensitive lookup
      for (const p of pathSet) {
        if (p.toLowerCase() === candidate.toLowerCase()) return p;
      }
    }
  }
  return null;
}

const README_NAMES = [
  "README.md",
  "README.MD",
  "Readme.md",
  "README",
  "readme.md",
  "README.txt",
  "README.markdown",
];

export function discoverCommunityFiles(paths: string[]): CommunityFiles {
  const pathSet = new Set(
    paths.map((p) => p.replace(/\\/g, "/").replace(/^\.\//, "")),
  );

  let readme: string | null = null;
  for (const name of README_NAMES) {
    for (const p of pathSet) {
      if (!p.includes("/") && p.toLowerCase() === name.toLowerCase()) {
        readme = p;
        break;
      }
    }
    if (readme) break;
  }

  // License path: highest-scoring root candidate (filename only; content detect separate)
  let license: string | null = null;
  let best = 0;
  for (const p of pathSet) {
    if (p.includes("/")) continue;
    const n = p.toLowerCase();
    let score = 0;
    if (/^(un)?licen[sc]e(\.|$)/.test(n)) score = 1;
    else if (/^copying(\.|$)/.test(n)) score = 0.9;
    else if (/^copyright(\.|$)/.test(n)) score = 0.35;
    else if (/^ofl(\.|$)/.test(n)) score = 0.4;
    if (score > best) {
      best = score;
      license = p;
    }
  }

  return {
    readme,
    license,
    codeOfConduct: findInDirs(pathSet, "CODE_OF_CONDUCT", DIRS),
    contributing: findInDirs(pathSet, "CONTRIBUTING", DIRS),
    security: findInDirs(pathSet, "SECURITY", DIRS),
  };
}

/**
 * Microbench: unique vs ambiguous path rate from Linguist catalog.
 * Usage: node freenet-linguist/scripts/bench-path-content.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(
  readFileSync(join(root, "../src/generated/catalog.json"), "utf8"),
);

function basename(path) {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

function extensionOf(base) {
  const lower = base.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot <= 0) return null;
  return lower.slice(dot);
}

function pathDetectionNeedsContent(path) {
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

const sample = [
  "src/main.rs",
  "src/lib.rs",
  "Cargo.toml",
  "README.md",
  "LICENSE",
  "build.rs",
  "include/foo.h",
  "scripts/run",
  "Makefile",
  "web/app.tsx",
  "pkg/mod.go",
  "data.json",
  "vendor/foo.js",
  "c/header.h",
  "python/setup.py",
  "Dockerfile",
  "shell/install",
  "a.m",
  "b.mm",
  "c.php",
];

const t0 = performance.now();
let need = 0;
const rounds = 20_000;
for (let i = 0; i < rounds; i++) {
  for (const p of sample) {
    if (pathDetectionNeedsContent(p)) need += 1;
  }
}
const ms = performance.now() - t0;
const total = sample.length * rounds;
const uniqueNeed = sample.filter((p) => pathDetectionNeedsContent(p));
console.log(
  `sample needContent: ${uniqueNeed.join(", ") || "(none)"}`,
);
console.log(
  `iters=${total} needContentRate≈${((need / total) * 100).toFixed(1)}% ${ms.toFixed(1)}ms`,
);

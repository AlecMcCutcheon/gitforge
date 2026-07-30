#!/usr/bin/env node
/**
 * Benchmark browser tip-pack decode (local CPU, no network / no IDB cache).
 *
 * Usage:
 *   node scripts/bench-pack-decode.mjs [packDir]
 *
 * Default packDir: ~/.local/share/freenet-gitforge/tips/<first>/packs
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const root = new URL("..", import.meta.url).pathname;

async function loadUnpack() {
  // Prefer compiled/transpiled path via vite-node-less dynamic import of TS via tsx if present.
  try {
    const mod = await import(
      pathToFileURL(join(root, "web/src/tip-browse/pack-decode.ts")).href
    );
    return mod.unpackPack;
  } catch {
    // Fallback: build-free copy using same algorithm via fflate from web deps
    throw new Error(
      "Could not import pack-decode.ts. Run with: npx tsx scripts/bench-pack-decode.mjs",
    );
  }
}

function defaultPackDir() {
  if (process.argv[2]) return process.argv[2];
  const tips = join(homedir(), ".local/share/freenet-gitforge/tips");
  if (!existsSync(tips)) {
    throw new Error(`No tip cache at ${tips}; pass a pack directory`);
  }
  for (const name of readdirSync(tips)) {
    const packs = join(tips, name, "packs");
    if (existsSync(packs)) return packs;
  }
  throw new Error(`No packs/ under ${tips}`);
}

const packDir = defaultPackDir();
const files = readdirSync(packDir)
  .filter((f) => f.endsWith(".pack"))
  .map((f) => join(packDir, f));

console.log(`packs: ${files.length} in ${packDir}`);

const unpackPack = await loadUnpack();

let totalBytes = 0;
let totalObjs = 0;
const t0 = performance.now();
for (const file of files) {
  const bytes = new Uint8Array(readFileSync(file));
  totalBytes += bytes.length;
  const t1 = performance.now();
  const objs = await unpackPack(bytes);
  const ms = performance.now() - t1;
  totalObjs += objs.size;
  console.log(
    `  ${file.split("/").pop()}  ${bytes.length} B  ${objs.size} objs  ${ms.toFixed(1)} ms`,
  );
}
const totalMs = performance.now() - t0;
console.log(
  `TOTAL  ${totalBytes} B  ${totalObjs} objs  ${totalMs.toFixed(1)} ms  (${(totalBytes / 1024 / (totalMs / 1000)).toFixed(0)} KiB/s)`,
);

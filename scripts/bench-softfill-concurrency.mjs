#!/usr/bin/env node
/**
 * Microbench: serial vs bounded-parallel soft-fill wall time model.
 * Models N tipped packs each taking `packMs` (fetch+decode), concurrency C.
 *
 * Usage: node scripts/bench-softfill-concurrency.mjs [packs=12] [packMs=80] [conc=2]
 */
const packs = Number(process.argv[2] ?? 12);
const packMs = Number(process.argv[3] ?? 80);
const conc = Number(process.argv[4] ?? 2);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runSerial(n, ms) {
  const t0 = performance.now();
  for (let i = 0; i < n; i++) await sleep(ms);
  return performance.now() - t0;
}

async function runParallel(n, ms, c) {
  const t0 = performance.now();
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= n) return;
      await sleep(ms);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(c, Math.max(1, n)) }, () => worker()),
  );
  return performance.now() - t0;
}

const serial = await runSerial(packs, packMs);
const parallel = await runParallel(packs, packMs, conc);
const ideal = (packs * packMs) / Math.min(conc, packs);

console.log(
  JSON.stringify(
    {
      packs,
      packMs,
      conc,
      serialMs: Math.round(serial),
      parallelMs: Math.round(parallel),
      idealMs: Math.round(ideal),
      speedup: Number((serial / parallel).toFixed(2)),
    },
    null,
    2,
  ),
);

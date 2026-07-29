/**
 * Chunk-GET pool calibration: samples (N, msPerChunk) → PAVA → desired size.
 */
import { pickBestPoolSize, type PavPoint } from "./chunk-pool-pav";

const STORAGE_KEY = "gitatlas.chunkPool.desiredN";
const SAMPLE_CAP = 48;
const EXPLORE_NS = [2, 4, 6, 8] as const;
const MIN_N = 1;
const MAX_N = 8;
const SAMPLES_PER_N_BEFORE_FIT = 2;

export interface ChunkPoolSample {
  n: number;
  wallMs: number;
  chunks: number;
  msPerChunk: number;
  at: number;
  /** True when many chunks fell back to the shell WS — skip for calib. */
  shellHeavy?: boolean;
}

const samples: ChunkPoolSample[] = [];
let exploreIdx = 0;
let forcedExploreN: number | null = null;

function loadDesired(): number | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    return Math.max(MIN_N, Math.min(MAX_N, Math.round(n)));
  } catch {
    return null;
  }
}

function saveDesired(n: number): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, String(n));
  } catch {
    /* ignore */
  }
}

let desiredN: number = loadDesired() ?? 4;

export function recordChunkPoolSample(input: {
  n: number;
  wallMs: number;
  chunks: number;
  shellHeavy?: boolean;
  aborted?: boolean;
}): void {
  if (input.aborted || input.shellHeavy) return;
  if (input.chunks <= 0 || input.wallMs <= 0 || input.n <= 0) return;
  const sample: ChunkPoolSample = {
    n: input.n,
    wallMs: input.wallMs,
    chunks: input.chunks,
    msPerChunk: input.wallMs / input.chunks,
    at: Date.now(),
    shellHeavy: input.shellHeavy,
  };
  samples.push(sample);
  while (samples.length > SAMPLE_CAP) samples.shift();

  const byN = new Map<number, number>();
  for (const s of samples) {
    byN.set(s.n, (byN.get(s.n) ?? 0) + 1);
  }
  const ready = EXPLORE_NS.every(
    (n) => (byN.get(n) ?? 0) >= SAMPLES_PER_N_BEFORE_FIT,
  );

  if (ready) {
    const points: PavPoint[] = samples.map((s) => ({
      n: s.n,
      msPerChunk: s.msPerChunk,
    }));
    const best = pickBestPoolSize(points, { min: MIN_N, max: MAX_N });
    if (best != null) {
      desiredN = best;
      saveDesired(best);
      forcedExploreN = null;
      console.info(
        `[chunk-pool-calib] PAVA suggest N=${best} (samples=${samples.length})`,
      );
    }
  } else {
    // Round-robin explore until enough per N
    forcedExploreN = EXPLORE_NS[exploreIdx % EXPLORE_NS.length]!;
    exploreIdx += 1;
    desiredN = forcedExploreN;
    saveDesired(desiredN);
  }
}

/** Target pool size for the next ensurePool / preferredChunkConcurrency. */
export function suggestPoolSize(): number {
  if (forcedExploreN != null) return forcedExploreN;
  return desiredN;
}

export function chunkPoolSampleCount(): number {
  return samples.length;
}

export function getChunkPoolSamples(): readonly ChunkPoolSample[] {
  return samples;
}

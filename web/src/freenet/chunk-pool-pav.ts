/**
 * Pair Adjacent Violators (isotonic) regression for discrete pool sizes.
 * Decreasing fit: more sockets → lower (or equal) msPerChunk after pooling violators.
 */
export interface PavPoint {
  n: number;
  msPerChunk: number;
}

/** Mean by N, then PAVA until y is non-increasing in N. */
export function pavDecreasing(points: PavPoint[]): PavPoint[] {
  if (points.length === 0) return [];

  const byN = new Map<number, { sum: number; count: number }>();
  for (const p of points) {
    const cur = byN.get(p.n) ?? { sum: 0, count: 0 };
    cur.sum += p.msPerChunk;
    cur.count += 1;
    byN.set(p.n, cur);
  }
  const ns = [...byN.keys()].sort((a, b) => a - b);
  type Block = { y: number; w: number; ns: number[] };
  const blocks: Block[] = ns.map((n) => {
    const c = byN.get(n)!;
    return { y: c.sum / c.count, w: c.count, ns: [n] };
  });

  let i = 0;
  while (i < blocks.length - 1) {
    if (blocks[i]!.y < blocks[i + 1]!.y) {
      const a = blocks[i]!;
      const b = blocks[i + 1]!;
      const w = a.w + b.w;
      const y = (a.y * a.w + b.y * b.w) / w;
      blocks.splice(i, 2, { y, w, ns: [...a.ns, ...b.ns] });
      if (i > 0) i -= 1;
    } else {
      i += 1;
    }
  }

  const fitted = new Map<number, number>();
  for (const block of blocks) {
    for (const n of block.ns) fitted.set(n, block.y);
  }
  return ns.map((n) => ({ n, msPerChunk: fitted.get(n)! }));
}

/** Pick N with lowest fitted msPerChunk among candidates that have samples. */
export function pickBestPoolSize(
  points: PavPoint[],
  clamp: { min: number; max: number },
): number | null {
  if (points.length === 0) return null;
  const fitted = pavDecreasing(points);
  let best = fitted[0]!;
  for (const p of fitted) {
    if (p.msPerChunk < best.msPerChunk) best = p;
  }
  return Math.max(clamp.min, Math.min(clamp.max, best.n));
}

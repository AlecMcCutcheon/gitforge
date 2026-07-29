/**
 * Approximate git-blame over tipped pack objects (first-parent + LCS line map).
 */

import type { BlameLine, BlameResponse } from "../api";
import { nativeEnsureTip } from "./native-api";
import {
  parseCommitFirstParent,
  parseCommitMeta,
  readBlobPath,
} from "../tip-browse/pack-decode";

const MAX_BLAME_COMMITS = 80;
/** Soft cap so LCS stays responsive in the SPA. */
const MAX_LCS_CELLS = 200_000;

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** LCS index pairs between `a` (parent) and `b` (child). */
function lcsIndexPairs(
  a: string[],
  b: string[],
): Array<{ a: number; b: number }> {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return [];
  if (n * m > MAX_LCS_CELLS) {
    const pairs: Array<{ a: number; b: number }> = [];
    const lim = Math.min(n, m);
    for (let i = 0; i < lim; i++) {
      if (a[i] === b[i]) pairs.push({ a: i, b: i });
    }
    return pairs;
  }

  const dp: Uint16Array[] = Array.from(
    { length: n + 1 },
    () => new Uint16Array(m + 1),
  );
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  const pairs: Array<{ a: number; b: number }> = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      pairs.push({ a: i - 1, b: j - 1 });
      i -= 1;
      j -= 1;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i -= 1;
    } else {
      j -= 1;
    }
  }
  pairs.reverse();
  return pairs;
}

interface Owner {
  hash: string;
  author: string;
  date: string;
  summary: string;
}

async function fileTextAtCommit(
  objects: Awaited<ReturnType<typeof nativeEnsureTip>>["objects"],
  commitHex: string,
  filePath: string,
): Promise<string> {
  const buf = await readBlobPath(objects, commitHex, filePath);
  return new TextDecoder().decode(buf);
}

export async function nativeBlame(
  prefix: string,
  _label: string,
  ref: string,
  path: string,
): Promise<BlameResponse> {
  const tip = await nativeEnsureTip(prefix, ref);
  const tipText = await fileTextAtCommit(tip.objects, tip.commit, path);
  const tipLines = splitLines(tipText);
  const owners: Array<Owner | null> = tipLines.map(() => null);
  let curHash: string | null = tip.commit;
  let curLines = tipLines;
  let tipIndex = tipLines.map((_, idx) => idx);
  const seen = new Set<string>();
  let steps = 0;

  while (curHash && !seen.has(curHash) && steps < MAX_BLAME_COMMITS) {
    steps += 1;
    seen.add(curHash);
    const cObj = tip.objects.get(curHash);
    if (!cObj || cObj.type !== "commit") break;

    const meta = parseCommitMeta(cObj.data);
    const owner: Owner = {
      hash: curHash,
      author: meta.author,
      date: meta.date,
      summary: meta.subject,
    };
    const parent = parseCommitFirstParent(cObj.data);

    let parentLines: string[];
    if (!parent || !tip.objects.has(parent)) {
      for (let i = 0; i < curLines.length; i++) {
        const t = tipIndex[i];
        if (t >= 0 && !owners[t]) owners[t] = owner;
      }
      break;
    }

    try {
      parentLines = splitLines(
        await fileTextAtCommit(tip.objects, parent, path),
      );
    } catch {
      parentLines = [];
    }

    const pairs = lcsIndexPairs(parentLines, curLines);
    const matchedCur = new Set(pairs.map((p) => p.b));
    for (let i = 0; i < curLines.length; i++) {
      if (!matchedCur.has(i)) {
        const t = tipIndex[i];
        if (t >= 0 && !owners[t]) owners[t] = owner;
      }
    }

    const newTipIndex = parentLines.map(() => -1);
    for (const { a, b } of pairs) {
      newTipIndex[a] = tipIndex[b];
    }
    tipIndex = newTipIndex;
    curLines = parentLines;
    curHash = parent;
    await yieldToUi();
  }

  // Anything still unassigned: use tip commit (truncated history).
  const tipObj = tip.objects.get(tip.commit);
  const tipMeta = tipObj ? parseCommitMeta(tipObj.data) : null;
  const tipOwner: Owner = {
    hash: tip.commit,
    author: tipMeta?.author ?? "unknown",
    date: tipMeta?.date ?? "",
    summary: tipMeta?.subject ?? "",
  };

  const lines: BlameLine[] = tipLines.map((content, idx) => {
    const o = owners[idx] ?? tipOwner;
    return {
      line: idx + 1,
      content,
      commit: o.hash,
      short: o.hash.slice(0, 7),
      author: o.author,
      date: o.date,
      summary: o.summary,
    };
  });

  return {
    path,
    ref,
    commit: tip.commit,
    lines,
    note:
      steps >= MAX_BLAME_COMMITS
        ? `Approximate blame from tipped packs (stopped after ${MAX_BLAME_COMMITS} commits).`
        : "Approximate blame from tipped packs (first-parent + line LCS).",
  };
}

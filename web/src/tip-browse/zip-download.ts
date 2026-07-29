/**
 * Client-side tip-tree ZIP for website mode (no bridge `/archive.zip`).
 */

import { zipSync } from "fflate";
import { loadBrowserTip } from "../freenet/tip-fetch";
import { listAllBlobPaths, readBlobPath } from "./pack-decode";

function triggerBlobDownload(filename: string, data: Uint8Array): void {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  const blob = new Blob([copy], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function zipRootName(label: string, ref: string): string {
  const base = label.replace(/\.git$/i, "") || "repo";
  const safeRef = ref.replace(/[^\w.-]+/g, "-") || "HEAD";
  return `${base}-${safeRef}`;
}

/** Build and download a ZIP of the tip tree at `ref` (website / tip-browse). */
export async function downloadSourceZip(
  prefix: string,
  label: string,
  ref: string,
): Promise<void> {
  const tip = await loadBrowserTip(prefix, ref);
  const paths = await listAllBlobPaths(tip.objects, tip.commit);
  const root = zipRootName(label, ref);
  const files: Record<string, Uint8Array> = {};
  for (const path of paths) {
    files[`${root}/${path}`] = await readBlobPath(tip.objects, tip.commit, path);
  }
  if (Object.keys(files).length === 0) {
    // Empty tip tree — still emit a valid zip with a placeholder dir entry via empty file.
    files[`${root}/.gitkeep`] = new Uint8Array(0);
  }
  const zipped = zipSync(files, { level: 6 });
  triggerBlobDownload(`${root}.zip`, zipped);
}

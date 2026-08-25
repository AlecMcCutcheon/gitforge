/** Resize an image File to a small data-URL for ForgeProfile custom avatar. */
export async function resizeImageToDataUrl(
  file: File,
  maxPx = 128,
  maxChars = 40_000,
): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new Error("Choose an image file");
  }

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const bitmap = await createImageBitmap(file);
  // … canvas.drawImage → canvas.toDataURL("image/jpeg") …
  // Canvas always samples one frame and JPEG-encodes — animated GIFs became
  // static photos. normalizeProfileAvatar already allows data:image/gif.
  // NEW CODE - TESTING: keep GIF bytes as gif data-URLs (size-capped)
  const isGif =
    file.type === "image/gif" || /\.gif$/i.test(file.name || "");
  if (isGif) {
    return fileToAnimatedFriendlyDataUrl(file, "image/gif", maxChars);
  }

  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxPx / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas unavailable");
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  let quality = 0.82;
  let dataUrl = canvas.toDataURL("image/jpeg", quality);
  while (dataUrl.length > maxChars && quality > 0.4) {
    quality -= 0.1;
    dataUrl = canvas.toDataURL("image/jpeg", quality);
  }
  if (dataUrl.length > maxChars) {
    throw new Error("Image is still too large after compression");
  }
  return dataUrl;
}

/** Base64 data-URL without re-encoding (preserves GIF animation). */
async function fileToAnimatedFriendlyDataUrl(
  file: File,
  mime: string,
  maxChars: number,
): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  // Chunked binary→base64 (spread of large Uint8Arrays can hit arg limits).
  let binary = "";
  const chunk = 0x2000;
  for (let i = 0; i < buf.length; i += chunk) {
    binary += String.fromCharCode(...buf.subarray(i, i + chunk));
  }
  const dataUrl = `data:${mime};base64,${btoa(binary)}`;
  if (dataUrl.length > maxChars) {
    const maxKiB = Math.max(1, Math.floor((maxChars * 3) / 4 / 1024));
    throw new Error(
      `GIF is too large for profile storage (keep under ~${maxKiB} KiB so animation can be kept). Use a smaller GIF, or a still image.`,
    );
  }
  return dataUrl;
}

/**
 * ForgeProfile.avatar must stay empty for procedural identicons.
 * Only user-uploaded raster data-URLs are persisted — never SVG (generator)
 * or remote URLs that would freeze an old look into the contract.
 */
export function isStoredCustomAvatar(
  value: string | null | undefined,
): boolean {
  const v = (value ?? "").trim();
  if (!v) return false;
  return /^data:image\/(jpeg|jpg|png|webp|gif);base64,/i.test(v);
}

/** Empty string when the profile should use the live fingerprint identicon. */
export function normalizeProfileAvatar(
  value: string | null | undefined,
): string {
  return isStoredCustomAvatar(value) ? value!.trim() : "";
}

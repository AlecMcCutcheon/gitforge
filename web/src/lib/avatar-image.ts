/** Resize an image File to a small data-URL for ForgeProfile custom avatar. */
export async function resizeImageToDataUrl(
  file: File,
  maxPx = 128,
  maxChars = 40_000,
): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new Error("Choose an image file");
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

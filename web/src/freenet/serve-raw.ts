/**
 * Turn fetched repo file bytes into a browser "raw file" document.
 *
 * Freenet website contracts cannot set HTTP Content-Type for dynamic git
 * blobs. The SPA runs in a sandboxed iframe (no allow-same-origin): Origin is
 * null, blob: URLs are blob:null (unusable), and the shell CSP is
 * `frame-src 'self'` — so Blob navigation must never run under Freenet.
 * We rewrite the document to a minimal raw page instead.
 */

export interface ServeRawFileInput {
  /** UTF-8 text when available. */
  text?: string | null;
  /** Base64 for binary / large payloads. */
  contentBase64?: string | null;
  mediaType?: string | null;
  filename?: string;
}

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** True when Blob URL navigation would break (Freenet shell / null origin). */
function mustRewriteDocument(): boolean {
  try {
    if (import.meta.env.VITE_BROWSER_NATIVE === "1") return true;
    if (typeof window === "undefined") return true;
    const path = window.location.pathname || "";
    if (path.includes("/v1/contract/web/") || path.includes("/v2/contract/web/")) {
      return true;
    }
    const search = window.location.search || "";
    if (search.includes("__sandbox")) return true;
    if (window.parent && window.parent !== window) return true;
    const o = window.location.origin;
    if (!o || o === "null" || o.startsWith("blob:")) return true;
    return false;
  } catch {
    return true;
  }
}

function mediaTypeFor(input: ServeRawFileInput): string {
  const mt = (input.mediaType ?? "").trim();
  if (mt) {
    if (mt.startsWith("text/") && !mt.includes("charset")) {
      return `${mt}; charset=utf-8`;
    }
    return mt;
  }
  if (input.text != null) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

function toBlob(input: ServeRawFileInput): Blob {
  const type = mediaTypeFor(input);
  if (input.contentBase64) {
    const bytes = decodeBase64(input.contentBase64);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return new Blob([copy], { type });
  }
  return new Blob([input.text ?? ""], { type });
}

function isTextual(input: ServeRawFileInput, type: string): boolean {
  return (
    type.startsWith("text/") ||
    type.includes("json") ||
    type.includes("xml") ||
    type.includes("javascript") ||
    type.includes("svg") ||
    input.text != null
  );
}

function rewriteTextDocument(filename: string, text: string): boolean {
  document.open();
  document.write("<!DOCTYPE html><html><head>");
  document.write('<meta charset="utf-8">');
  document.write(
    '<meta name="color-scheme" content="dark">',
  );
  document.write(`<title>${filename.replace(/[<>&"]/g, "")}</title>`);
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // white GitHub-raw look: background:#fff;color:#24292f
  // NEW CODE - TESTING: GitAtlas dark (black bg, light text)
  document.write(
    "<style>html,body{margin:0;background:#0e1412;color:#e8f0eb}" +
      "pre{margin:0;padding:16px;white-space:pre-wrap;word-wrap:break-word;" +
      "font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}</style>",
  );
  document.write("</head><body><pre id=\"r\"></pre>");
  document.write(
    `<script>document.getElementById("r").textContent=${JSON.stringify(text)};</script>`,
  );
  document.write("</body></html>");
  document.close();
  return true;
}

function rewriteBinaryDocument(filename: string, input: ServeRawFileInput): boolean {
  const safeName = filename.replace(/[<>&"]/g, "");
  // Prefer data: download — blob:null is blocked under Freenet sandbox.
  let href = "";
  if (input.contentBase64) {
    const mt = (input.mediaType ?? "application/octet-stream").split(";")[0]?.trim()
      || "application/octet-stream";
    href = `data:${mt};base64,${input.contentBase64}`;
  } else if (input.text != null) {
    href = `data:application/octet-stream;base64,${btoa(unescape(encodeURIComponent(input.text)))}`;
  }

  document.open();
  document.write("<!DOCTYPE html><html><head>");
  document.write('<meta charset="utf-8">');
  document.write('<meta name="color-scheme" content="dark">');
  document.write(`<title>${safeName}</title>`);
  document.write(
    "<style>body{margin:0;padding:2rem;font:14px system-ui;background:#0e1412;color:#e8f0eb}" +
      "a{color:#3ecf8e}</style>",
  );
  document.write("</head><body>");
  document.write(`Binary file: ${safeName} `);
  if (href) {
    document.write(
      `<a download="${safeName}" href="${href.replace(/"/g, "")}">Download</a>`,
    );
  } else {
    document.write("(no downloadable payload in this sandbox)");
  }
  document.write("</body></html>");
  document.close();
  return true;
}

/**
 * Replace the current tab with a raw file response (Blob URL or rewritten doc).
 * Returns true when navigation / rewrite was kicked off.
 */
export function serveRawFileInCurrentDocument(input: ServeRawFileInput): boolean {
  const filename = input.filename?.trim() || "raw";
  const type = mediaTypeFor(input);

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // Prefer Blob navigation when origin looked usable — breaks Freenet shell:
  // blob:null + CSP frame-src 'self' → "Refused to frame" / local resource errors.
  // if (hasUsableOrigin()) {
  //   const url = URL.createObjectURL(toBlob(input));
  //   window.location.replace(url);
  //   return true;
  // }

  // NEW CODE - TESTING: always rewrite under Freenet; Blob only for standalone tabs.
  if (mustRewriteDocument()) {
    try {
      if (isTextual(input, type)) {
        const text =
          input.text ??
          new TextDecoder().decode(
            input.contentBase64 ? decodeBase64(input.contentBase64) : new Uint8Array(),
          );
        return rewriteTextDocument(filename, text);
      }
      return rewriteBinaryDocument(filename, input);
    } catch {
      return false;
    }
  }

  // Standalone (local Vite / non-sandboxed): Blob navigation ≈ GitHub raw.
  try {
    const url = URL.createObjectURL(toBlob(input));
    window.location.replace(url);
    return true;
  } catch {
    /* fall through */
  }

  try {
    if (isTextual(input, type)) {
      const text =
        input.text ??
        new TextDecoder().decode(
          input.contentBase64 ? decodeBase64(input.contentBase64) : new Uint8Array(),
        );
      return rewriteTextDocument(filename, text);
    }
    return rewriteBinaryDocument(filename, input);
  } catch {
    return false;
  }
}

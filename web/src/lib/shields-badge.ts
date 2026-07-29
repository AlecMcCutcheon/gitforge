/**
 * Freenet-safe Shields badges: parse img.shields.io URLs and render SVG
 * locally as data: URIs (allowed under Freenet sandbox CSP).
 *
 * We do NOT use the npm `badge-maker` package in the browser — it depends on
 * `anafanafo` → `fs` font tables and crashes the SPA bundle.
 * Layout matches Shields flat / flat-square closely enough for README previews.
 *
 * Live service data (CI, crates version, matrix count) is not in the URL and
 * cannot be fetched under CSP. Static `/badge/…` paths render fully; dynamic
 * routes get a best-effort label/message from the path/query.
 *
 * @see https://shields.io/badges
 */

export interface BadgeFormat {
  label?: string;
  message: string;
  color?: string;
  labelColor?: string;
  style?: "plastic" | "flat" | "flat-square" | "for-the-badge" | "social";
}

const SHIELDS_HOST = "img.shields.io";

const STYLES = new Set<string>([
  "plastic",
  "flat",
  "flat-square",
  "for-the-badge",
  "social",
]);

/** Shields named colors (subset used by badge-maker). */
const NAMED: Record<string, string> = {
  brightgreen: "#4c1",
  green: "#97ca00",
  yellow: "#dfb317",
  yellowgreen: "#a4a61d",
  orange: "#fe7d37",
  red: "#e05d44",
  blue: "#007ec6",
  grey: "#555",
  gray: "#555",
  lightgrey: "#9f9f9f",
  lightgray: "#9f9f9f",
  critical: "#e05d44",
  important: "#fe7d37",
  success: "#4c1",
  informational: "#007ec6",
  inactive: "#9f9f9f",
};

function isShieldsHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === SHIELDS_HOST || h === "shields.io" || h.endsWith(".shields.io");
}

function styleFromQuery(q: URLSearchParams): BadgeFormat["style"] {
  const s = (q.get("style") ?? "flat").toLowerCase();
  return (STYLES.has(s) ? s : "flat") as BadgeFormat["style"];
}

function isLikelyColor(token: string): boolean {
  const t = token.toLowerCase();
  if (t in NAMED) return true;
  if (/^([\da-f]{3}|[\da-f]{6})$/i.test(t)) return true;
  return false;
}

function resolveColor(color: string | undefined, fallback: string): string {
  if (!color) return fallback;
  const c = color.trim().toLowerCase();
  if (c in NAMED) return NAMED[c]!;
  if (/^#?([\da-f]{3}|[\da-f]{6})$/i.test(c)) {
    return c.startsWith("#") ? c : `#${c}`;
  }
  return fallback;
}

/** Shields path encoding: `_`→space, `__`→`_`, `--`→`-`. */
function decodeShieldsToken(raw: string): string {
  return raw
    .replace(/--/g, "\0")
    .replace(/__/g, "\x01")
    .replace(/_/g, " ")
    .replace(/\0/g, "-")
    .replace(/\x01/g, "_");
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Approx Verdana 11px width (Shields uses measured tables; good enough here). */
function textWidth(str: string): number {
  let w = 0;
  for (const ch of str) {
    if (ch === " ") w += 3.5;
    else if (/[ilI|.'`]/.test(ch)) w += 3.5;
    else if (/[mwMW@%]/.test(ch)) w += 9;
    else if (ch === ch.toUpperCase() && /[A-Z]/.test(ch)) w += 7.5;
    else w += 6.5;
  }
  return w;
}

/**
 * Minimal flat / flat-square SVG (browser-safe; no Node font tables).
 * OLD: badge-maker makeBadge — crashed via anafanafo/fs in the Freenet SPA.
 */
export function makeBadgeSvg(format: BadgeFormat): string {
  const label = (format.label ?? "").trim();
  const message = `${format.message}`.trim() || " ";
  const style = format.style ?? "flat";
  const height = style === "for-the-badge" ? 28 : 20;
  const fontSize = style === "for-the-badge" ? 10 : 11;
  const pad = style === "for-the-badge" ? 10 : 6;
  const radius = style === "flat-square" || style === "for-the-badge" ? 0 : 3;

  const labelW = label
    ? Math.ceil(textWidth(label) + pad * 2)
    : 0;
  const messageW = Math.ceil(textWidth(message) + pad * 2);
  const width = Math.max(labelW + messageW, 1);
  const labelColor = resolveColor(format.labelColor, "#555");
  const messageColor = resolveColor(format.color, "#9f9f9f");
  const midY = height / 2;
  // Optical baseline for Verdana-like text in SVG
  const textY = midY + (style === "for-the-badge" ? 4 : 3.5);
  const accessible = label ? `${label}: ${message}` : message;

  const labelRect =
    labelW > 0
      ? `<rect x="0" y="0" width="${labelW}" height="${height}" fill="${labelColor}"/>`
      : "";
  const messageRect = `<rect x="${labelW}" y="0" width="${messageW}" height="${height}" fill="${messageColor}"/>`;

  const labelText =
    labelW > 0
      ? `<text x="${labelW / 2}" y="${textY}" fill="#fff" text-anchor="middle">${escapeXml(label)}</text>`
      : "";
  const messageText = `<text x="${labelW + messageW / 2}" y="${textY}" fill="#fff" text-anchor="middle">${escapeXml(message)}</text>`;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" role="img" aria-label="${escapeXml(accessible)}">` +
    `<title>${escapeXml(accessible)}</title>` +
    (radius > 0
      ? `<clipPath id="r"><rect width="${width}" height="${height}" rx="${radius}"/></clipPath><g clip-path="url(#r)">`
      : "<g>") +
    labelRect +
    messageRect +
    `<g fill="#fff" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="${fontSize}"` +
    (style === "for-the-badge" ? ' font-weight="bold" text-transform="uppercase"' : "") +
    `>` +
    // soft shadow like shields flat
    (labelW > 0
      ? `<text aria-hidden="true" x="${labelW / 2}" y="${textY + 1}" fill="#010101" fill-opacity=".3" text-anchor="middle">${escapeXml(label)}</text>`
      : "") +
    `<text aria-hidden="true" x="${labelW + messageW / 2}" y="${textY + 1}" fill="#010101" fill-opacity=".3" text-anchor="middle">${escapeXml(message)}</text>` +
    labelText +
    messageText +
    `</g></g></svg>`
  );
}

function parseStaticBadgeContent(
  content: string,
  q: URLSearchParams,
): BadgeFormat | null {
  const body = content.replace(/\.(svg|png|gif|jpg|jpeg)$/i, "");
  if (!body) return null;

  const protectedBody = body.replace(/--/g, "\0").replace(/__/g, "\x01");
  const parts = protectedBody.split("-").map((p) =>
    decodeShieldsToken(p.replace(/\0/g, "--").replace(/\x01/g, "__")),
  );
  if (parts.length === 0) return null;

  let color = "lightgrey";
  let labelParts = parts;
  if (parts.length >= 2 && isLikelyColor(parts[parts.length - 1]!)) {
    color = parts[parts.length - 1]!;
    labelParts = parts.slice(0, -1);
  }

  let label = "";
  let message = "";
  if (labelParts.length === 1) {
    message = labelParts[0]!;
  } else if (labelParts.length >= 2) {
    label = labelParts[0]!;
    message = labelParts.slice(1).join(" ");
  }

  const labelQ = q.get("label");
  const messageQ = q.get("message") ?? q.get("value");
  const colorQ = q.get("color") ?? q.get("colour");
  if (labelQ != null) label = labelQ;
  if (messageQ != null) message = messageQ;
  if (colorQ != null) color = colorQ;

  if (!message) message = " ";
  return {
    label,
    message,
    color,
    labelColor: q.get("labelColor") ?? q.get("labelColour") ?? undefined,
    style: styleFromQuery(q),
  };
}

function parseDynamicShields(
  pathParts: string[],
  q: URLSearchParams,
): BadgeFormat | null {
  const style = styleFromQuery(q);
  const labelOverride = q.get("label");
  const colorOverride = q.get("color") ?? q.get("colour") ?? undefined;

  if (
    pathParts[0] === "github" &&
    pathParts[1] === "actions" &&
    pathParts[2] === "workflow" &&
    pathParts[3] === "status"
  ) {
    return {
      label: labelOverride || "build",
      message: "offline",
      color: colorOverride || "lightgrey",
      style,
    };
  }

  if (pathParts[0] === "crates" && pathParts[1] === "v" && pathParts[2]) {
    return {
      label: labelOverride || "crates.io",
      message: decodeURIComponent(
        pathParts[2].replace(/\.(svg|png|gif|jpg|jpeg)$/i, ""),
      ),
      color: colorOverride || "orange",
      style,
    };
  }

  if (pathParts[0] === "matrix" && pathParts[1]) {
    const room = decodeURIComponent(pathParts.slice(1).join("/"));
    const short = room.split(":")[0] || "chat";
    return {
      label: labelOverride || "matrix",
      message: short,
      color: colorOverride || "lightgrey",
      style,
    };
  }

  if (
    (pathParts[0] === "npm" ||
      pathParts[0] === "pypi" ||
      pathParts[0] === "docker") &&
    pathParts[1] === "v" &&
    pathParts[2]
  ) {
    return {
      label: labelOverride || pathParts[0],
      message: decodeURIComponent(
        pathParts[2].replace(/\.(svg|png|gif|jpg|jpeg)$/i, ""),
      ),
      color: colorOverride || "blue",
      style,
    };
  }

  if (pathParts[0] && pathParts[0] !== "badge" && pathParts[0] !== "static") {
    return {
      label: labelOverride || pathParts[0],
      message: "offline",
      color: colorOverride || "lightgrey",
      style,
    };
  }

  return null;
}

export function parseShieldsBadgeUrl(src: string): BadgeFormat | null {
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return null;
  }
  if (!/^https?:$/i.test(url.protocol)) return null;
  if (!isShieldsHost(url.hostname)) return null;

  const q = url.searchParams;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length === 0) return null;

  if (parts[0] === "static" && (parts[1] === "v1" || parts.length === 1)) {
    const message = q.get("message") ?? q.get("value");
    if (!message) return null;
    return {
      label: q.get("label") ?? "",
      message,
      color: q.get("color") ?? q.get("colour") ?? "lightgrey",
      labelColor: q.get("labelColor") ?? undefined,
      style: styleFromQuery(q),
    };
  }

  if (parts[0] === "badge" && parts[1]) {
    return parseStaticBadgeContent(parts.slice(1).join("/"), q);
  }

  if (parts[0] === "endpoint") {
    return {
      label: q.get("label") || "endpoint",
      message: "offline",
      color: "lightgrey",
      style: styleFromQuery(q),
    };
  }

  return parseDynamicShields(parts, q);
}

/** Build a data:image/svg+xml URI for a shields URL, or null. */
export function shieldsUrlToDataUri(src: string): string | null {
  const format = parseShieldsBadgeUrl(src);
  if (!format) return null;
  try {
    const svg = makeBadgeSvg(format);
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  } catch {
    return null;
  }
}

export function isShieldsImageUrl(src: string | null | undefined): boolean {
  if (!src) return false;
  try {
    const u = new URL(src);
    return isShieldsHost(u.hostname);
  } catch {
    return false;
  }
}

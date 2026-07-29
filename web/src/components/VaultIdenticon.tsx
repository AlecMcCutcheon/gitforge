/**
 * GitHub-style identicon — algorithm from joric/identicons
 * (https://github.com/joric/identicons), which reverse-engineered
 * github.com/identicons.
 *
 * GitHub hashes the numeric user id; we hash the Freenet fingerprint
 * (`freenet:id:…`) instead so the avatar is identity-stable, not name-based.
 */
import { md5 } from "@noble/hashes/legacy";

interface VaultIdenticonProps {
  /** Fingerprint (or other stable id). Not a display username. */
  seed: string;
  size?: number;
  className?: string;
  title?: string;
}

interface IdenticonModel {
  /** CSS rgb() for filled cells */
  color: string;
  /** GitHub background #f0f0f0 */
  bg: string;
  /** 5×5 mask, row-major */
  cells: boolean[];
}

function md5Hex(seed: string): string {
  const digest = md5(new TextEncoder().encode(seed.trim() || "freenet:id:"));
  let hex = "";
  for (let i = 0; i < digest.length; i++) {
    hex += digest[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}

function nibblesFromHex(hex: string): number[] {
  const nib: number[] = [];
  for (let i = 0; i < hex.length; i++) {
    nib.push(parseInt(hex.charAt(i), 16));
  }
  return nib;
}

/** Python colorsys.hls_to_rgb — same as joric/generate.py. */
function hlsToRgb(h: number, l: number, s: number): [number, number, number] {
  if (s === 0) {
    const v = l;
    return [v, v, v];
  }
  const m2 = l <= 0.5 ? l * (1 + s) : l + s - l * s;
  const m1 = 2 * l - m2;
  const hue2rgb = (p: number, q: number, t: number): number => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  return [
    hue2rgb(m1, m2, h + 1 / 3),
    hue2rgb(m1, m2, h),
    hue2rgb(m1, m2, h - 1 / 3),
  ];
}

/**
 * Build mask + color exactly as joric/identicons (GitHub).
 * @see https://github.com/joric/identicons/blob/main/generate.py
 */
export function buildVaultIdenticon(seed: string): IdenticonModel {
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // cameron-style: s = 65 - sat*20/255; l = 75 - lgt*20/255 (percent HSL)
  // NEW CODE - TESTING: joric GitHub formula (MD5 → HLS + even-nibble mask)

  const nib = nibblesFromHex(md5Hex(seed));

  // Column x uses nibble row [2,1,0,1,2][x]*5 + y; even → filled.
  const colSource = [2, 1, 0, 1, 2] as const;
  const cells: boolean[] = [];
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 5; x++) {
      const idx = colSource[x]! * 5 + y;
      cells.push(nib[idx]! % 2 === 0);
    }
  }

  const hueBits = (nib[25]! << 8) | (nib[26]! << 4) | nib[27]!;
  const satBits = (nib[28]! << 4) | nib[29]!;
  const lgtBits = (nib[30]! << 4) | nib[31]!;
  // generate.py: h/16/256, (960-l)/5/256, (832-s)/5/256
  const h = hueBits / (16 * 256);
  const l = (960 - lgtBits) / (5 * 256);
  const s = (832 - satBits) / (5 * 256);
  const [r, g, b] = hlsToRgb(h, l, s).map((v) => Math.round(v * 255)) as [
    number,
    number,
    number,
  ];

  return {
    color: `rgb(${r},${g},${b})`,
    bg: "#f0f0f0",
    cells,
  };
}

/** Identicon as a data URL for Freenet shell OAuth chrome (same algorithm as the SVG component). */
export function vaultIdenticonDataUrl(seed: string): string {
  const model = buildVaultIdenticon(seed);
  const cells = model.cells
    .map((on, i) =>
      on
        ? `<rect x="${(i % 5) + 0.5}" y="${Math.floor(i / 5) + 0.5}" width="1" height="1" fill="${model.color}"/>`
        : "",
    )
    .join("");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 6 6" shape-rendering="crispEdges">` +
    `<rect width="6" height="6" fill="${model.bg}"/>` +
    cells +
    `</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function VaultIdenticon({
  seed,
  size = 32,
  className,
  title,
}: VaultIdenticonProps) {
  const model = buildVaultIdenticon(seed);
  // GitHub draws 5×5 in a 6×6 logical frame (half-cell margin). Keep SVG viewBox 0..6.
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 6 6"
      className={className}
      role="img"
      aria-label={title ?? "Identity avatar"}
      shapeRendering="crispEdges"
    >
      {title ? <title>{title}</title> : null}
      <rect width="6" height="6" fill={model.bg} />
      {model.cells.map((on, i) =>
        on ? (
          <rect
            key={i}
            x={(i % 5) + 0.5}
            y={Math.floor(i / 5) + 0.5}
            width="1"
            height="1"
            fill={model.color}
          />
        ) : null,
      )}
    </svg>
  );
}

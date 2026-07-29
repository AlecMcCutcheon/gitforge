export interface FreenetGitUrl {
  prefix: string;
  label: string;
  /** Form used by git remote helper */
  remote: string;
  /** Display form without double colon */
  display: string;
  cacheKey: string;
}

const URL_RE =
  /^(?:freenet::|freenet:)?([1-9A-HJ-NP-Za-km-z]{8,24})(?:\/([A-Za-z0-9._~-]+))?$/;

export function parseFreenetUrl(input: string): FreenetGitUrl {
  const trimmed = input.trim();
  const match = URL_RE.exec(trimmed);
  if (!match) {
    throw new Error(
      `Invalid Freenet git URL: "${input}". Expected freenet::prefix/label`,
    );
  }
  const prefix = match[1];
  const label = match[2] ?? "repo";
  return {
    prefix,
    label,
    remote: `freenet::${prefix}/${label}`,
    display: `freenet:${prefix}/${label}`,
    cacheKey: `${prefix}__${label}`,
  };
}

export const DEMO_REPOS = [
  {
    name: "freenet-stdlib",
    description: "Full history + tags — best demo for browsing files/commits",
    url: "freenet::96rknpy1GYhZ/freenet-stdlib",
    mode: "history" as const,
  },
  {
    name: "freenet-git",
    description: "freenet-git itself — full history",
    url: "freenet::99TmCayXn6Tm/freenet-git",
    mode: "history" as const,
  },
  {
    name: "freenet-core",
    description:
      "Legacy-pack heavy — tip-browse may error until tip metadata exists (Code tab will not full-clone)",
    url: "freenet::3GEERif5ihbf/freenet-core",
    mode: "snapshot" as const,
  },
];

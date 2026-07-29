/** Official Freenet mirrors curated for GitAtlas (same list as server DEMO_REPOS). */
export const EMBEDDED_DEMOS: Array<{
  name: string;
  description: string;
  url: string;
  mode: "snapshot" | "history";
}> = [
  {
    name: "freenet-stdlib",
    description: "Full history + tags — best demo for browsing files/commits",
    url: "freenet::96rknpy1GYhZ/freenet-stdlib",
    mode: "history",
  },
  {
    name: "freenet-git",
    description: "freenet-git itself — full history",
    url: "freenet::99TmCayXn6Tm/freenet-git",
    mode: "history",
  },
  {
    name: "freenet-core",
    description:
      "Legacy-pack heavy — tip-browse may error until tip metadata exists (Code tab will not full-clone)",
    url: "freenet::3GEERif5ihbf/freenet-core",
    mode: "snapshot",
  },
];

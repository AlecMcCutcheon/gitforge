/**
 * Freenet website contract key for GitAtlas (`fdev website` name: freenethub).
 * Synced by scripts/sync-website-key.sh before publish.
 */
export const GITATLAS_WEBSITE_CONTRACT_KEY =
  "8fumEu7EKYk6vhDXsMWfeSWcXayN9UhSyQQemtVw4SL7";

/** Gateway path prefix for this website contract. */
export function gitatlasWebsiteBasename(): string {
  return `/v1/contract/web/${GITATLAS_WEBSITE_CONTRACT_KEY}`;
}

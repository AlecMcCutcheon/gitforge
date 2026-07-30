/**
 * Freenet website contract key for GitForge (`fdev website` name: gitforge).
 * Synced by scripts/sync-website-key.sh before publish.
 * Key bytes stay stable — only the display/fdev name may change.
 */
export const FORGE_WEBSITE_CONTRACT_KEY =
  "AtNJZ7PtZbuJKpuqtsWbrfK5VCkWmMiDcK42y1S7LdMk";

/** Gateway path prefix for this website contract. */
export function forgeWebsiteBasename(): string {
  return `/v1/contract/web/${FORGE_WEBSITE_CONTRACT_KEY}`;
}

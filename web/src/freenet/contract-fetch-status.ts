/**
 * Freenet shell shows "Fetching contract from the network…" while a GET is
 * still in flight on peers (HTTP 503 + auto-refresh). GitAtlas talks over WS
 * after the SPA is loaded, so it must surface the same idea itself.
 */

/** Match freenet-core `retry_loading_page` heading. */
export const FREENET_FETCHING_CONTRACT =
  "Fetching contract from the network…";

export const FREENET_FETCHING_CONTRACT_HINT =
  "Your node is asking peers for this contract. This can take a while when it is not cached locally.";

/** Overall tip-pack / tree load budget (shell GET wait is 30s). */
export const TIP_LOAD_DEADLINE_MS = 45_000;

export function isContractNotFoundError(err: unknown): boolean {
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    /contract not found/.test(m) ||
    /missing contract/.test(m) ||
    /empty state/.test(m)
  );
}

export function isContractFetchTimeoutError(err: unknown): boolean {
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    /timed out/.test(m) ||
    /request timeout/.test(m) ||
    /tip load deadline/.test(m)
  );
}

export function tipLoadDeadlineError(prefix: string): Error {
  return new Error(
    `Tip load deadline (${Math.round(TIP_LOAD_DEADLINE_MS / 1000)}s) for ${prefix}: ` +
      `still fetching contracts from the network. ` +
      `They may still be propagating — retry, or check the Freenet dashboard.`,
  );
}

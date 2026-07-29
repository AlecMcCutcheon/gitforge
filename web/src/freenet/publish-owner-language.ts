/**
 * Owner-only: after linguist runs, cache primary language on HubRegistry
 * public_meta (dual-sig upsert). Skips when unchanged / not owner / unregistered.
 */
import { currentIdentity, getCachedIdentity } from "./auth-api";
import { peekCachedRegistry, upsertCachedRegistryEntry } from "./discover-cache";
import { fetchHubRegistry } from "./hub-registry";
import { nativeRegisterRepo } from "./owner-api";
import {
  applyLanguageToPublicMeta,
  registryLanguageIsCurrent,
} from "./registry-lang";
import type { HubRegistration } from "../api";

const inflight = new Set<string>();

export async function maybePublishOwnerPrimaryLanguage(input: {
  prefix: string;
  tipCommit: string;
  primary: { name: string; color: string | null };
}): Promise<HubRegistration | null> {
  const primaryName = input.primary.name.trim();
  const tip = input.tipCommit.trim();
  if (!primaryName || !tip || !input.prefix) return null;

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const self = getCachedIdentity();
  // if (!self?.fingerprint) return null;
  // NEW CODE - TESTING: cache may be empty right after idle linguist — probe session
  let self = getCachedIdentity();
  if (!self?.fingerprint) {
    self = (await currentIdentity().catch(() => null)) ?? null;
  }
  if (!self?.fingerprint) {
    console.warn(
      "[freenet-hub] language publish skipped: not signed in",
      input.prefix,
    );
    return null;
  }

  const key = `${input.prefix}:${tip}:${primaryName}`;
  if (inflight.has(key)) return null;
  inflight.add(key);

  try {
    let listing =
      peekCachedRegistry()?.find((r) => r.repo_prefix === input.prefix) ?? null;
    if (!listing) {
      const { repos } = await fetchHubRegistry().catch(() => ({
        repos: [] as HubRegistration[],
      }));
      listing = repos.find((r) => r.repo_prefix === input.prefix) ?? null;
    }
    if (!listing) {
      console.warn(
        "[freenet-hub] language publish skipped: not on HubRegistry",
        input.prefix,
      );
      return null;
    }
    if (
      listing.identity_fingerprint.toLowerCase() !==
      self.fingerprint.toLowerCase()
    ) {
      console.warn(
        "[freenet-hub] language publish skipped: not registry owner",
        input.prefix,
      );
      return null;
    }
    if (registryLanguageIsCurrent(listing.public_meta, primaryName, tip)) {
      return listing;
    }

    const public_meta = applyLanguageToPublicMeta(
      listing.public_meta,
      input.primary,
      tip,
    );
    const entry = await nativeRegisterRepo({
      prefix: listing.repo_prefix,
      label: listing.label,
      name: listing.name ?? undefined,
      description: listing.description ?? undefined,
      website: listing.website ?? null,
      topics: listing.topics ?? [],
      public_meta,
    });
    try {
      upsertCachedRegistryEntry(entry);
    } catch {
      /* optional */
    }
    console.info(
      "[freenet-hub] published primary language",
      primaryName,
      "for",
      input.prefix.slice(0, 12),
    );
    return entry;
  } catch (e) {
    console.warn(
      "[freenet-hub] owner language publish failed:",
      e instanceof Error ? e.message : e,
    );
    return null;
  } finally {
    inflight.delete(key);
  }
}

/**
 * ForgeRegistry client facade.
 *
 * Bridge mode: HTTP `/api/registry*` (local-bundle attestation).
 * Website / browser-native: ForgeRegistry contract over Freenet WS.
 */

import { api, type ForgeRegistration, type PersonResponse } from "../api";
import { isBrowserNativeMode } from "../tip-browse";
import {
  personDisplayFallback,
  resolvePersonDisplayName,
} from "../freenet/person-display";
import { fetchForgeRegistry } from "../freenet/forge-registry";
import { nativeRegisterRepo, nativeUnregisterRepo } from "../freenet/owner-api";

export async function listDiscoverRegistry(): Promise<{
  repos: ForgeRegistration[];
  note?: string;
  source: "bridge" | "contract" | "unavailable";
}> {
  if (isBrowserNativeMode()) {
    const { loadRegistryCached } = await import("../freenet/discover-cache");
    const repos = await loadRegistryCached(() => fetchForgeRegistry());
    return { repos, source: "contract" };
  }
  const data = await api.registry();
  return {
    repos: data.repos,
    note: data.note,
    source: "bridge",
  };
}

export async function lookupRegistration(
  prefix: string,
): Promise<ForgeRegistration | null> {
  if (isBrowserNativeMode()) {
    const { loadRegistryCached } = await import("../freenet/discover-cache");
    const repos = await loadRegistryCached(() => fetchForgeRegistry());
    return repos.find((r) => r.repo_prefix === prefix) ?? null;
  }
  try {
    return await api.registryLookup(prefix);
  } catch {
    return null;
  }
}

export async function loadPerson(
  fingerprint: string,
): Promise<PersonResponse> {
  if (isBrowserNativeMode()) {
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // displayName from mine[0]?.identity_name (stale ForgeRegistry username)
    // NEW CODE - TESTING: ForgeProfile username by fingerprint
    const { peekCachedRegistry, loadRegistryCached, storeCachedRegistry } =
      await import("../freenet/discover-cache");
    const stub = async (repos: ForgeRegistration[]): Promise<PersonResponse> => {
      const mine = repos.filter(
        (r) =>
          r.identity_fingerprint.toLowerCase() === fingerprint.toLowerCase(),
      );
      const displayName = await resolvePersonDisplayName(fingerprint).catch(
        () => personDisplayFallback(fingerprint),
      );
      return {
        fingerprint,
        displayName,
        email: mine[0]?.identity_email ?? null,
        repos: mine,
        note: "From ForgeRegistry contract (filter by identity_fingerprint).",
      };
    };
    const cached = peekCachedRegistry();
    if (cached) {
      void loadRegistryCached(() => fetchForgeRegistry()).catch(() => undefined);
      return stub(cached);
    }
    try {
      const fresh = await Promise.race([
        loadRegistryCached(() => fetchForgeRegistry()),
        new Promise<ForgeRegistration[]>((resolve) =>
          setTimeout(() => resolve([]), 10_000),
        ),
      ]);
      storeCachedRegistry(fresh);
      return stub(fresh);
    } catch {
      return stub([]);
    }
  }
  return api.person(fingerprint);
}

export async function registerOwnedRepo(input: {
  prefix: string;
  label: string;
  name?: string;
  description?: string;
}): Promise<ForgeRegistration> {
  if (isBrowserNativeMode()) {
    return nativeRegisterRepo(input);
  }
  return api.registerRepo(input);
}

export async function unregisterOwnedRepo(prefix: string): Promise<void> {
  if (isBrowserNativeMode()) {
    await nativeUnregisterRepo({ prefix });
    return;
  }
  await api.unregisterRepo(prefix);
}

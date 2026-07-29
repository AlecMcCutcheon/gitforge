/**
 * Collaborator invites: seal site key + owner site-key coupon into recipient inbox.
 * Repo-level pending invite is written to HubRegistry; inbox is only the user notify.
 * Accept: invitee identity-signs coupon → HubRegistry Put → then import secret.
 * Deny: invitee removes HubRegistry pending invite, then prunes inbox.
 */
import { bytesToHex, randomBytes } from "@noble/hashes/utils";
import {
  appendInboxMessage,
  fetchHubProfile,
  type HubProfileStateJson,
} from "./hub-profile";
import {
  fetchHubRegistry,
  type HubRegistryPendingInviteOp,
} from "./hub-registry";
import { sealInboxMessage } from "./inbox-crypto";
import {
  nativeAddPendingInvite,
  nativeExportRepos,
  nativeGetIdentity,
  nativeSignContributorInvite,
  type ContributorInviteCoupon,
} from "./owner-api";
import { resolvePersonRef } from "./people-resolve";
import {
  fingerprintWordsJoined,
} from "./fingerprint-words";

export const REPO_INVITE_KIND = "repo-invite";

/** UI “Invite expired” after this (sealed invite may still be accept-able). */
export const PENDING_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type { ContributorInviteCoupon };

export interface RepoInviteBody {
  prefix: string;
  label: string;
  secret_hex: string;
  repo_name?: string;
  /** Owner site-key coupon for this invitee — required for accept (v2). */
  coupon?: ContributorInviteCoupon;
}

export interface PersonSearchHit {
  fingerprint: string;
  username: string;
  avatar: string;
  wordSlug: string;
  inbox_pk: string;
  profile: HubProfileStateJson;
  /** Set when search runs against a repo listing — blocks re-invite. */
  inviteBlockedReason?: string | null;
}

export function contributorFingerprintsForPrefix(
  contributors: Record<string, Record<string, { identity_fingerprint?: string }>>,
  prefix: string,
): Set<string> {
  const map = contributors[prefix] ?? {};
  return new Set(Object.keys(map));
}

export function pendingInviteFingerprintsForPrefix(
  pendingInvites: Record<string, Record<string, HubRegistryPendingInviteOp>>,
  prefix: string,
): Set<string> {
  return new Set(Object.keys(pendingInvites[prefix] ?? {}));
}

export function pendingInvitesForPrefix(
  pendingInvites: Record<string, Record<string, HubRegistryPendingInviteOp>>,
  prefix: string,
): HubRegistryPendingInviteOp[] {
  return Object.values(pendingInvites[prefix] ?? {});
}

export function isPendingInviteExpired(
  updatedAt: string,
  now = Date.now(),
): boolean {
  const t = Date.parse(updatedAt);
  if (!Number.isFinite(t)) return false;
  return now - t > PENDING_INVITE_TTL_MS;
}

/** Why this person cannot be invited for this listing (or null if ok). */
export function inviteBlockReason(input: {
  recipientFingerprint: string;
  ownerFingerprint: string | null | undefined;
  contributorFingerprints: Set<string>;
  pendingInviteFingerprints?: Set<string>;
}): string | null {
  const fp = input.recipientFingerprint;
  if (
    input.ownerFingerprint &&
    fp === input.ownerFingerprint
  ) {
    return "That identity is already the registry owner of this repository";
  }
  if (input.contributorFingerprints.has(fp)) {
    return "That identity is already a verified contributor on this repository";
  }
  if (input.pendingInviteFingerprints?.has(fp)) {
    return "An invitation is already pending for that identity";
  }
  return null;
}

export async function searchPersonForInvite(
  query: string,
  opts?: {
    /** HubRegistry listing owner fingerprint for this repo. */
    ownerFingerprint?: string | null;
    /** Already-accepted contributor fingerprints for this repo. */
    contributorFingerprints?: Set<string>;
    /** Pending (not yet accepted/declined) invite fingerprints. */
    pendingInviteFingerprints?: Set<string>;
  },
): Promise<
  | { ok: true; hit: PersonSearchHit }
  | { ok: false; error: string; empty?: boolean }
> {
  const q = query.trim();
  if (!q) {
    return { ok: false, error: "Enter a fingerprint or fingerprint words", empty: true };
  }
  const resolved = await resolvePersonRef(q);
  if (!resolved.ok) {
    return { ok: false, error: resolved.error, empty: true };
  }
  const profile = await fetchHubProfile(resolved.fingerprint, {
    reliable: true,
  });
  if (!profile) {
    return {
      ok: false,
      error: "No profiles found",
      empty: true,
    };
  }
  const blocked = inviteBlockReason({
    recipientFingerprint: profile.identity_fingerprint,
    ownerFingerprint: opts?.ownerFingerprint,
    contributorFingerprints: opts?.contributorFingerprints ?? new Set(),
    pendingInviteFingerprints: opts?.pendingInviteFingerprints,
  });
  return {
    ok: true,
    hit: {
      fingerprint: profile.identity_fingerprint,
      username: profile.username || "Unknown",
      avatar: profile.avatar || "",
      wordSlug: fingerprintWordsJoined(profile.identity_fingerprint),
      inbox_pk: profile.inbox_pk || "",
      profile,
      inviteBlockedReason: blocked,
    },
  };
}

export async function sendRepoInvite(input: {
  prefix: string;
  label: string;
  repoName?: string;
  recipientFingerprint: string;
  onStatus?: (msg: string) => void;
}): Promise<{ messageId: string }> {
  const self = await nativeGetIdentity();
  if (!self) throw new Error("Sign in before inviting collaborators");

  input.onStatus?.("Checking registry membership…");
  const registry = await fetchHubRegistry();
  const listing = registry.repos.find((r) => r.repo_prefix === input.prefix);
  if (!listing) {
    throw new Error("Repository is not listed on GitAtlas — Register first");
  }
  if (listing.identity_fingerprint !== self.fingerprint) {
    throw new Error("Only the GitAtlas registry owner can invite collaborators");
  }
  const contribs = contributorFingerprintsForPrefix(
    registry.contributors ?? {},
    input.prefix,
  );
  const pending = pendingInviteFingerprintsForPrefix(
    registry.pending_invites ?? {},
    input.prefix,
  );
  const blocked = inviteBlockReason({
    recipientFingerprint: input.recipientFingerprint,
    ownerFingerprint: listing.identity_fingerprint,
    contributorFingerprints: contribs,
    pendingInviteFingerprints: pending,
  });
  if (blocked) throw new Error(blocked);

  input.onStatus?.("Looking up their profile inbox…");
  const profile = await fetchHubProfile(input.recipientFingerprint, {
    reliable: true,
  });
  if (!profile) {
    throw new Error("No profile found for that identity");
  }
  if (!profile.inbox_pk) {
    throw new Error(
      "Their profile has no inbox yet — they need to create or restore a GitAtlas identity once so inbox_pk is provisioned.",
    );
  }

  input.onStatus?.("Exporting this repo’s site key…");
  const repos = await nativeExportRepos();
  const row = repos.find((r) => r.prefix === input.prefix);
  if (!row?.secret_hex) {
    throw new Error(
      "Site key for this repo is not on this node — you must be the owner with the key in your identity delegate.",
    );
  }

  // NEW CODE - TESTING: owner site-key coupon binds grant to this invitee
  input.onStatus?.("Signing contributor invite coupon…");
  const coupon = await nativeSignContributorInvite({
    prefix: input.prefix,
    inviteeFingerprint: profile.identity_fingerprint,
  });
  if (coupon.repo_owner_vk !== listing.repo_owner_vk) {
    throw new Error(
      "Site key verifying key does not match the GitAtlas listing — re-register or check keys",
    );
  }

  // NEW CODE - TESTING: repo-level pending invite on HubRegistry (source of truth)
  input.onStatus?.("Recording pending invite on HubRegistry…");
  await nativeAddPendingInvite({
    prefix: input.prefix,
    inviteeFingerprint: profile.identity_fingerprint,
  });

  const body: RepoInviteBody = {
    prefix: input.prefix,
    label: row.label || input.label,
    secret_hex: row.secret_hex,
    coupon,
    ...(input.repoName ? { repo_name: input.repoName } : {}),
  };
  const plaintext = JSON.stringify({
    v: 2,
    kind: REPO_INVITE_KIND,
    body,
  });

  input.onStatus?.("Sealing invite to their inbox…");
  const ciphertext_b64 = sealInboxMessage(profile.inbox_pk, plaintext);
  const messageId = bytesToHex(randomBytes(8));
  const created_at = new Date().toISOString();

  input.onStatus?.("Signing + delivering with your GitAtlas identity…");
  await appendInboxMessage({
    fingerprint: profile.identity_fingerprint,
    message: {
      id: messageId,
      ciphertext_b64,
      created_at,
    },
  });

  return { messageId };
}

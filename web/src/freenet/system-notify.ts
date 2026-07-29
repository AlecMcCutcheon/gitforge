/**
 * Self-inbox system notifications (backup worker, account heal, …).
 * Signed by the user's identity — UI treats self-signed / gitatlas.* as System.
 */
import { randomBytes, bytesToHex } from "@noble/hashes/utils";
import {
  sealInboxMessage,
  inboxPkHexFromSeedHex,
  listInboxPlaintexts,
  setCachedInboxMessages,
  type DecryptedInboxMessage,
} from "./inbox-crypto";
import { appendInboxMessage, fetchHubProfile } from "./hub-profile";
import { nativeExportIdentity } from "./owner-api";

export const SYSTEM_KIND_BACKUP_CREATED = "gitatlas.system.backup_created";
export const SYSTEM_KIND_BACKUP_UPDATED = "gitatlas.system.backup_updated";
export const SYSTEM_KIND_ACCOUNT_HEALED = "gitatlas.system.account_healed";
export const SYSTEM_KIND_REPO_CONTRACTS_PROVISIONED =
  "gitatlas.system.repo_contracts_provisioned";

export interface SystemNotifyBody {
  title: string;
  detail?: string;
  prefix?: string;
}

export function isSystemInboxKind(kind: string | undefined | null): boolean {
  if (!kind) return false;
  return (
    kind.startsWith("gitatlas.system.") ||
    kind.startsWith("gitatlas.backup.")
  );
}

export function isSelfSignedInbox(
  senderVk: string | undefined | null,
  selfPublicKeyB58: string | undefined | null,
): boolean {
  if (!senderVk || !selfPublicKeyB58) return false;
  return senderVk.trim() === selfPublicKeyB58.trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Best-effort: seal a system notice into the signed-in user's own inbox. */
export async function notifySelfSystem(
  kind: string,
  body: SystemNotifyBody,
): Promise<void> {
  const { currentIdentity, getCachedIdentity } = await import("./auth-api");
  let id = getCachedIdentity();
  if (!id) {
    id = (await currentIdentity().catch(() => null)) ?? null;
  }
  if (!id) {
    console.warn("[freenet-hub] system notify skipped: not signed in");
    return;
  }

  const messageId = bytesToHex(randomBytes(8));
  const created_at = new Date().toISOString();
  const plaintextObj = { v: 1, kind, body };
  const plaintext = JSON.stringify(plaintextObj);

  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // Prefer seed-derived inbox_pk for self so seal/decrypt always match
      const exported = await nativeExportIdentity();
      const seedPk = inboxPkHexFromSeedHex(exported.secret_key);
      const profile = await fetchHubProfile(id.fingerprint, {
        reliable: true,
      }).catch(() => null);
      const inboxPk = seedPk || profile?.inbox_pk?.trim() || "";
      if (!inboxPk) {
        console.warn("[freenet-hub] system notify skipped: no inbox_pk");
        return;
      }
      const ciphertext_b64 = sealInboxMessage(inboxPk, plaintext);
      await appendInboxMessage({
        fingerprint: id.fingerprint,
        message: {
          id: messageId,
          ciphertext_b64,
          created_at,
        },
      });

      // Optimistic session cache — Freenet GET may lag after Put
      const cached: DecryptedInboxMessage = {
        id: messageId,
        created_at,
        sender_vk: id.public_key_b58,
        raw: new TextEncoder().encode(plaintext),
        plaintext: plaintextObj,
      };
      const prior = listInboxPlaintexts().filter((m) => m.id !== messageId);
      setCachedInboxMessages([cached, ...prior]);

      try {
        const { refreshInboxSession } = await import("./auth-api");
        await refreshInboxSession();
      } catch {
        /* keep optimistic cache */
      }
      try {
        window.dispatchEvent(
          new CustomEvent("freenethub-inbox-updated", {
            detail: { kind },
          }),
        );
      } catch {
        /* ignore */
      }
      return;
    } catch (err) {
      lastErr = err;
      console.warn(
        `[freenet-hub] system notify attempt ${attempt}/3:`,
        err instanceof Error ? err.message : err,
      );
      if (attempt < 3) await sleep(800 * attempt);
    }
  }
  console.warn(
    "[freenet-hub] system notify failed:",
    lastErr instanceof Error ? lastErr.message : lastErr,
  );
}

/**
 * One-shot: drop failed freenet-git create leftovers from identity bundle + vault.
 * Keeps freenet:7FMQGtHpkidg/gitatlas (registered).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  openFreenetGitIdentityBundle,
  sealFreenetGitIdentityBundle,
} from "../../web/src/freenet/freenet-git-bundle.ts";
import {
  apiKeyWrapsSigningJson,
  authorizedOpsSigningJson,
  buildVaultSigningPayload,
  decryptEnvelopeWithDek,
  encryptEnvelopeWithDek,
  ENVELOPE_REPOS,
  envelopesSigningJson,
  findApiKeyWrap,
  identityDekWrapSigningJson,
  SIG_KIND_OPS,
  signVaultPayloadLocally,
  unwrapApiKeyPayload,
  VAULT_SCHEMA_VERSION,
  type ForgeVaultPublicState,
  type ReposEnvelopePlaintext,
} from "../../web/src/freenet/vault-crypto.ts";
import { fetchForgeVault, putOrUpdateForgeVault } from "../../web/src/freenet/forge-vault.ts";
import { nativeImportRepoKey } from "../../web/src/freenet/owner-api.ts";
import { resetFreenetConn } from "../../web/src/freenet/ws.ts";

const KEEP = new Set(["7FMQGtHpkidg"]);
const JUNK = new Set(["HJmpEvknvro1", "5UV6MZUeTtdw", "59s4QBQfKyar"]);

async function main(): Promise<void> {
  const apiKey = process.env.GATK || process.env.GITFORGE_API_KEY;
  const passphrase = process.env.FREENET_GIT_PASSPHRASE;
  const bundlePath = process.env.FREENET_GIT_IDENTITY;
  const vaultId =
    process.env.VAULT_ID ||
    "503b61b2d8c5a58eb8d1d04881d814d499bd0b63c310c39cb423782cd06008eb";
  if (!apiKey || !passphrase || !bundlePath) {
    throw new Error("Need GATK, FREENET_GIT_PASSPHRASE, FREENET_GIT_IDENTITY");
  }

  const abs = resolve(bundlePath);
  const opened = openFreenetGitIdentityBundle(
    new Uint8Array(readFileSync(abs)),
    passphrase,
  );
  console.error("Bundle before:");
  for (const r of opened.repos) {
    console.error(`  ${r.prefix}/${r.label}`);
  }

  const kept = opened.repos.filter((r) => KEEP.has(r.prefix));
  const dropped = opened.repos.filter(
    (r) => JUNK.has(r.prefix) || !KEEP.has(r.prefix),
  );
  if (kept.length === 0) {
    throw new Error("keep-list matched zero bundle repos — abort");
  }
  console.error("Dropping:");
  for (const r of dropped) console.error(`  ${r.prefix}/${r.label}`);
  console.error("Keeping:");
  for (const r of kept) console.error(`  ${r.prefix}/${r.label}`);

  const sealed = sealFreenetGitIdentityBundle({
    name: opened.name,
    email: opened.email,
    secret_key_hex: opened.secret_key_hex,
    repos: kept,
    passphrase,
  });
  writeFileSync(abs, sealed);
  // Keep default CLI path in sync when pruning the Downloads copy.
  const defaultBundle = resolve(
    process.env.HOME || "",
    ".config/freenet/git-identity.bundle",
  );
  try {
    writeFileSync(defaultBundle, sealed);
    console.error(`Wrote ${defaultBundle}`);
  } catch (e) {
    console.error(`Skip default bundle write: ${e}`);
  }
  console.error(`Wrote pruned bundle ${abs}`);

  const state = await fetchForgeVault(vaultId);
  if (!state?.identity_dek_wrap?.blob_b64) {
    throw new Error("vault missing");
  }
  if (state.schema_version !== VAULT_SCHEMA_VERSION) {
    throw new Error(`vault schema ${state.schema_version}`);
  }
  const wrap = findApiKeyWrap(state.api_key_wraps, apiKey);
  if (!wrap) throw new Error("API key not recognized");
  const payload = await unwrapApiKeyPayload(apiKey, wrap);
  const dek = payload.deks[ENVELOPE_REPOS];
  if (!dek || !payload.ops_sk_hex) throw new Error("missing DEK/ops");
  const reposCipher = state.envelopes?.[ENVELOPE_REPOS];
  if (!reposCipher) throw new Error("missing repos envelope");
  const env = decryptEnvelopeWithDek<ReposEnvelopePlaintext>(dek, reposCipher);
  const before = { ...(env.repos ?? {}) };
  console.error("Vault before:");
  for (const [p, r] of Object.entries(before)) {
    console.error(`  ${p} ${r.label}`);
  }

  const repos: ReposEnvelopePlaintext["repos"] = {};
  for (const r of kept) {
    repos[r.prefix] = {
      secret_hex: r.secret_hex,
      label: r.label || before[r.prefix]?.label || r.prefix,
    };
  }
  // Preserve any non-junk vault-only keys the user may have added.
  for (const [p, r] of Object.entries(before)) {
    if (JUNK.has(p)) continue;
    if (KEEP.has(p)) continue;
    repos[p] = r;
  }
  console.error("Vault after:");
  for (const [p, r] of Object.entries(repos)) {
    console.error(`  ${p} ${r.label}`);
  }

  const nextEnvelopes = {
    ...state.envelopes,
    [ENVELOPE_REPOS]: encryptEnvelopeWithDek(dek, {
      repos,
    } satisfies ReposEnvelopePlaintext),
  };
  const updated_at = new Date().toISOString();
  const seq = state.seq + 1;
  const wraps = state.api_key_wraps;
  const authorized_ops = state.authorized_ops;
  const identity_dek_wrap = state.identity_dek_wrap!;
  const signInput = {
    vault_id: vaultId,
    username: state.username,
    identity_fingerprint: state.identity_fingerprint,
    envelopes_json: envelopesSigningJson(nextEnvelopes),
    identity_dek_wrap_json: identityDekWrapSigningJson(identity_dek_wrap),
    api_key_wraps_json: apiKeyWrapsSigningJson(wraps),
    authorized_ops_json: authorizedOpsSigningJson(authorized_ops),
    seq,
    updated_at,
    sig_kind: SIG_KIND_OPS,
  };
  const sig = signVaultPayloadLocally(
    payload.ops_sk_hex,
    buildVaultSigningPayload(signInput),
  );
  const next: ForgeVaultPublicState = {
    schema_version: VAULT_SCHEMA_VERSION,
    vault_id: vaultId,
    envelopes: nextEnvelopes,
    identity_dek_wrap,
    identity_fingerprint: state.identity_fingerprint,
    username: state.username,
    seq,
    updated_at,
    sig_kind: SIG_KIND_OPS,
    sig,
    ...(wraps?.length ? { api_key_wraps: wraps } : {}),
    ...(authorized_ops?.length ? { authorized_ops } : {}),
  };
  await putOrUpdateForgeVault(vaultId, next);
  console.error("Vault repos envelope updated.");

  console.error("Re-importing kept keys into local delegate…");
  for (const r of kept) {
    await nativeImportRepoKey(r.prefix, r.secret_hex, r.label);
  }
  console.error(`Imported ${kept.length} key(s).`);
  try {
    await resetFreenetConn();
  } catch {
    /* ignore */
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

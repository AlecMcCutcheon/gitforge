#!/usr/bin/env npx tsx
/**
 * GitAtlas vault CLI — push/pull freenet-git bundles ↔ HubVault (schema v4).
 *
 * Push (bundle → vault), ops-signed:
 *   npx tsx scripts/cli/gitatlas-vault.ts sync-bundle \
 *     --api-key "$GATK" --bundle ./git-identity.bundle --bundle-passphrase '…'
 *
 * Pull (vault → bundle):
 *   npx tsx scripts/cli/gitatlas-vault.ts pull-bundle \
 *     --api-key "$GATK" --bundle ./git-identity.bundle --bundle-passphrase '…' \
 *     [--out ./updated.bundle] [--import-local-delegate]
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
  vaultIdFromSeedHex,
  type HubVaultPublicState,
  type ReposEnvelopePlaintext,
} from "../../web/src/freenet/vault-crypto.ts";
import { fetchHubVault, putOrUpdateHubVault } from "../../web/src/freenet/hub-vault.ts";
import { nativeImportRepoKey } from "../../web/src/freenet/owner-api.ts";
import { resetFreenetConn } from "../../web/src/freenet/ws.ts";

function usage(): never {
  console.error(`Usage:
  gitatlas-vault sync-bundle --api-key <key> --bundle <path> [options]
  gitatlas-vault pull-bundle  --api-key <key> --bundle <path> [options]

Shared options:
  --bundle-passphrase <pw>   Bundle passphrase (or FREENET_GIT_PASSPHRASE)
  --vault-id <64hex>         Override vault id (default: derive from bundle seed)
  --import-local-delegate    Also ImportRepoKey into this node's hub-identity
  --ws <url>                 Freenet command WS URL

pull-bundle only:
  --out <path>               Write updated bundle (default: overwrite --bundle)

Environment:
  GATK / GITATLAS_API_KEY
  FREENET_GIT_PASSPHRASE
  VITE_FREENET_WS_URL / FREENET_WS_URL
`);
  process.exit(2);
}

function argValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  return argv[i + 1];
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

async function unlockReposFromVault(opts: {
  apiKey: string;
  vault_id: string;
  fingerprint: string;
}): Promise<{
  state: HubVaultPublicState;
  dek: string;
  ops_sk_hex: string;
  repos: Record<string, { secret_hex: string; label: string }>;
  wrapScopes: string[];
}> {
  const state = await fetchHubVault(opts.vault_id);
  if (!state?.identity_dek_wrap?.blob_b64) {
    throw new Error(
      "no GitAtlas vault for this identity — create/restore identity in GitAtlas first",
    );
  }
  if (state.schema_version !== VAULT_SCHEMA_VERSION) {
    throw new Error(
      `unsupported vault schema_version ${state.schema_version} (need ${VAULT_SCHEMA_VERSION})`,
    );
  }
  if (state.identity_fingerprint !== opts.fingerprint) {
    throw new Error("bundle fingerprint does not match vault identity");
  }
  const wrap = findApiKeyWrap(state.api_key_wraps, opts.apiKey);
  if (!wrap) {
    throw new Error("API key not recognized for this vault");
  }
  const scopes = wrap.scopes.map((s) =>
    s === "vault:merge-repos" ? ENVELOPE_REPOS : s,
  );
  if (!scopes.includes(ENVELOPE_REPOS)) {
    throw new Error(
      `API key missing repos scope (have: ${wrap.scopes.join(", ")})`,
    );
  }
  const payload = await unwrapApiKeyPayload(opts.apiKey, wrap);
  const dek = payload.deks[ENVELOPE_REPOS];
  if (!dek || !payload.ops_sk_hex) {
    throw new Error("API key wrap missing repos DEK or ops key");
  }
  const reposCipher = state.envelopes?.[ENVELOPE_REPOS];
  if (!reposCipher) {
    throw new Error("vault missing repos envelope");
  }
  const env = decryptEnvelopeWithDek<ReposEnvelopePlaintext>(dek, reposCipher);
  return {
    state,
    dek,
    ops_sk_hex: payload.ops_sk_hex,
    repos: env.repos ?? {},
    wrapScopes: scopes,
  };
}

async function syncBundle(opts: {
  apiKey: string;
  bundlePath: string;
  bundlePassphrase: string;
  vaultIdOverride?: string;
  importLocalDelegate: boolean;
}): Promise<void> {
  const bytes = new Uint8Array(readFileSync(resolve(opts.bundlePath)));
  const opened = openFreenetGitIdentityBundle(bytes, opts.bundlePassphrase);
  const vault_id =
    opts.vaultIdOverride?.trim().toLowerCase() ||
    vaultIdFromSeedHex(opened.secret_key_hex);
  console.error(`Identity ${opened.fingerprint}`);
  console.error(`Vault    ${vault_id}`);

  const unlocked = await unlockReposFromVault({
    apiKey: opts.apiKey,
    vault_id,
    fingerprint: opened.fingerprint,
  });
  const { state, dek, ops_sk_hex } = unlocked;
  const repos = { ...unlocked.repos };
  let added = 0;
  for (const repo of opened.repos) {
    if (!repos[repo.prefix]) added += 1;
    repos[repo.prefix] = {
      secret_hex: repo.secret_hex,
      label: repo.label || repos[repo.prefix]?.label || repo.prefix,
    };
  }
  console.error(`Merged ${added} new repo key(s) from bundle into vault set.`);

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
    vault_id,
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
    ops_sk_hex,
    buildVaultSigningPayload(signInput),
  );

  const next: HubVaultPublicState = {
    schema_version: VAULT_SCHEMA_VERSION,
    vault_id,
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

  await putOrUpdateHubVault(vault_id, next);
  console.error("GitAtlas vault repos envelope updated (ops-signed).");

  if (opts.importLocalDelegate) {
    console.error("Importing repo keys into local hub-identity delegate…");
    let n = 0;
    for (const repo of opened.repos) {
      await nativeImportRepoKey(repo.prefix, repo.secret_hex, repo.label);
      n += 1;
    }
    console.error(`Imported ${n} repo key(s) into local delegate.`);
  } else {
    console.error(
      "Vault-only push. Use pull-bundle or --import-local-delegate / UI Sync as needed.",
    );
  }
}

async function pullBundle(opts: {
  apiKey: string;
  bundlePath: string;
  bundlePassphrase: string;
  outPath: string;
  vaultIdOverride?: string;
  importLocalDelegate: boolean;
}): Promise<void> {
  const bundlePath = resolve(opts.bundlePath);
  const bytes = new Uint8Array(readFileSync(bundlePath));
  const opened = openFreenetGitIdentityBundle(bytes, opts.bundlePassphrase);
  const vault_id =
    opts.vaultIdOverride?.trim().toLowerCase() ||
    vaultIdFromSeedHex(opened.secret_key_hex);
  console.error(`Identity ${opened.fingerprint}`);
  console.error(`Vault    ${vault_id}`);

  const unlocked = await unlockReposFromVault({
    apiKey: opts.apiKey,
    vault_id,
    fingerprint: opened.fingerprint,
  });

  const byPrefix = new Map(
    opened.repos.map((r) => [r.prefix, { ...r }] as const),
  );
  let added = 0;
  let updated = 0;
  for (const [prefix, repo] of Object.entries(unlocked.repos)) {
    const prev = byPrefix.get(prefix);
    if (!prev) {
      byPrefix.set(prefix, {
        prefix,
        label: repo.label,
        secret_hex: repo.secret_hex,
      });
      added += 1;
    } else if (
      prev.secret_hex.toLowerCase() !== repo.secret_hex.toLowerCase()
    ) {
      byPrefix.set(prefix, {
        prefix,
        label: repo.label || prev.label,
        secret_hex: repo.secret_hex,
      });
      updated += 1;
    }
  }
  const mergedRepos = [...byPrefix.values()];
  console.error(
    `Pull: +${added} new, ${updated} updated from vault; ${mergedRepos.length} total in bundle.`,
  );

  const sealed = sealFreenetGitIdentityBundle({
    secret_key_hex: opened.secret_key_hex,
    public_key_b58: opened.public_key_b58,
    name: opened.name,
    email: opened.email,
    repos: mergedRepos,
    passphrase: opts.bundlePassphrase,
  });
  const outPath = resolve(opts.outPath);
  writeFileSync(outPath, sealed);
  console.error(`Wrote ${outPath}`);

  if (opts.importLocalDelegate) {
    console.error("Importing vault repo keys into local hub-identity…");
    let n = 0;
    for (const repo of mergedRepos) {
      await nativeImportRepoKey(repo.prefix, repo.secret_hex, repo.label);
      n += 1;
    }
    console.error(`Imported/updated ${n} repo key(s) on local delegate.`);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (cmd !== "sync-bundle" && cmd !== "pull-bundle") usage();

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // "ws://127.0.0.1:7509/v1/contract/command?encodingProtocol=native";
  // FreenetWsApi appends encodingProtocol=flatbuffers → duplicate query hangs connect.
  // NEW CODE - TESTING: bare command path; stdlib sets encoding
  const ws =
    argValue(argv, "--ws") ||
    process.env.VITE_FREENET_WS_URL ||
    process.env.FREENET_WS_URL ||
    "ws://127.0.0.1:7509/v1/contract/command";
  process.env.VITE_FREENET_WS_URL = ws;

  const apiKey =
    argValue(argv, "--api-key") ||
    process.env.GATK ||
    process.env.GITATLAS_API_KEY ||
    "";
  const bundlePath = argValue(argv, "--bundle");
  const bundlePassphrase =
    argValue(argv, "--bundle-passphrase") ??
    process.env.FREENET_GIT_PASSPHRASE ??
    "";
  const vaultIdOverride = argValue(argv, "--vault-id");
  const importLocalDelegate = hasFlag(argv, "--import-local-delegate");
  const outPath = argValue(argv, "--out") || bundlePath;

  if (!apiKey || !bundlePath) usage();

  try {
    if (cmd === "sync-bundle") {
      await syncBundle({
        apiKey,
        bundlePath,
        bundlePassphrase,
        vaultIdOverride,
        importLocalDelegate,
      });
    } else {
      await pullBundle({
        apiKey,
        bundlePath,
        bundlePassphrase,
        outPath: outPath!,
        vaultIdOverride,
        importLocalDelegate,
      });
    }
  } finally {
    try {
      resetFreenetConn();
    } catch {
      /* ignore */
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

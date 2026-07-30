/**
 * Browser Freenet tip push: encode pack → Put pack contract → SignPush → Put/Update tip.
 */
import { blake3 } from "@noble/hashes/blake3";
import { brand } from "../lib/brand";
import { PACK_WASM_HASH_B58, REPO_WASM_HASH_B58 } from "./constants";
import {
  bytesToHex,
  packFirstCommit,
  type CommitFile,
} from "../tip-browse/pack-encode";
import { buildPutRequest, wrapDeltaUpdate } from "./put";
import {
  encodeRepoParams,
  packContractKey,
  repoContractKey,
} from "./keys";
import { clearRepoTipCaches } from "./native-api";
import { nativeGetIdentity, nativeSignPush } from "./owner-api";
import { clearRepoStateCache, fetchRepoState } from "./tip-fetch";
import {
  getContractState,
  putContract,
  updateContract,
} from "./ws";

const PUSH_WRITE_TIMEOUT_MS = 45_000;

function refNameForBranch(branch: string): string {
  const b = branch.trim() || "main";
  return b.startsWith("refs/") ? b : `refs/heads/${b}`;
}

function withWriteTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(`${label} timed out after ${PUSH_WRITE_TIMEOUT_MS}ms`),
        ),
      PUSH_WRITE_TIMEOUT_MS,
    );
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function hexDecode(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase().replace(/^0x/, "");
  if (clean.length % 2 !== 0) throw new Error("hex length must be even");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error(`invalid hex at ${i * 2}`);
    out[i] = byte;
  }
  return out;
}

async function loadPackWasm(): Promise<Uint8Array> {
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const packResp = await fetch("./pack-contract.wasm");
  // if (packResp.ok) {
  //   return new Uint8Array(await packResp.arrayBuffer());
  // }
  // throw new Error(
  //   "failed to fetch pack-contract.wasm — run build:owner so web/public has it",
  // );
  // NEW CODE - TESTING: shared public WASM cache (docs/15-freenet-git-ws-hygiene.md)
  try {
    const { loadPublicWasm } = await import("./wasm-cache");
    return await loadPublicWasm("./pack-contract.wasm");
  } catch {
    throw new Error(
      "failed to fetch pack-contract.wasm — run build:owner so web/public has it",
    );
  }
}

async function loadRepoWasm(): Promise<Uint8Array> {
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const resp = await fetch("./repo-contract.wasm");
  // if (resp.ok) {
  //   return new Uint8Array(await resp.arrayBuffer());
  // }
  // throw new Error(
  //   "failed to fetch repo-contract.wasm — copy freenet-git repo-contract.wasm into web/public/",
  // );
  // NEW CODE - TESTING
  try {
    const { loadPublicWasm } = await import("./wasm-cache");
    return await loadPublicWasm("./repo-contract.wasm");
  } catch {
    throw new Error(
      "failed to fetch repo-contract.wasm — copy freenet-git repo-contract.wasm into web/public/",
    );
  }
}

/** Subscribe + fetch so this node can host before Update fallback. */
async function primeRepoHosting(prefix: string): Promise<void> {
  const key = repoContractKey(prefix);
  try {
    await getContractState(key, {
      priority: "high",
      timeoutMs: 12_000,
      maxAttempts: 2,
      fetchContract: true,
      subscribe: true,
      scope: prefix,
    });
  } catch (err) {
    console.warn(
      "[freenet-push] prime hosting:",
      err instanceof Error ? err.message : err,
    );
  }
}

export async function pushFilesToFreenet(input: {
  prefix: string;
  branch?: string;
  files: CommitFile[];
  subject: string;
  description?: string;
  authorName?: string;
  authorEmail?: string;
  onProgress?: (msg: string) => void;
}): Promise<{ tipHashHex: string; packHashHex: string; refName: string }> {
  if (!input.files.length) {
    throw new Error("nothing to commit");
  }
  const id = await nativeGetIdentity();
  if (!id) {
    throw new Error("sign in before pushing");
  }
  const authorName =
    (input.authorName ?? id.name ?? brand.displayName).trim() || brand.displayName;
  const authorEmail =
    (
      input.authorEmail ??
      id.email ??
      `${id.fingerprint.slice(0, 12)}@users.freenet`
    ).trim() || "user@freenet";
  const message = input.description?.trim()
    ? `${input.subject.trim()}\n\n${input.description.trim()}`
    : input.subject.trim() || `Add files via ${brand.displayName}`;

  const { packBytes, tipHashHex } = packFirstCommit({
    files: input.files,
    authorName,
    authorEmail,
    message,
  });
  const refName = refNameForBranch(input.branch ?? "main");
  const report = input.onProgress;

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const packHash = blake3(packBytes);
  // const packHashHex = bytesToHex(packHash);
  // … single Put …
  // NEW CODE - TESTING: SinglePack ≤ 1MiB; ChunkedPack above (freenet-git DEFAULT_CHUNK_SIZE)
  const {
    DEFAULT_CHUNK_SIZE,
    publishChunkedPackPhases,
  } = await import("./chunked-pack");

  let packHashHex: string;
  let signed: { delta_hex: string; state_hex: string };

  const stateBytes = await fetchRepoState(input.prefix);
  const stateHex = bytesToHex(stateBytes);

  if (packBytes.byteLength > DEFAULT_CHUNK_SIZE) {
    report?.(
      `Publishing ChunkedPack (${packBytes.byteLength} bytes)…`,
    );
    const published = await publishChunkedPackPhases(packBytes, {
      scope: input.prefix,
      onProgress: (p) => {
        if (p.phase === "put_chunk") {
          report?.(`Putting chunk ${p.i}/${p.n}…`);
        } else if (p.phase === "verify_chunk") {
          report?.(`Verifying chunk ${p.i}/${p.n}…`);
        } else if (p.phase === "put_manifest") {
          report?.("Putting ChunkedPack manifest…");
        } else {
          report?.("Verifying ChunkedPack manifest…");
        }
      },
    });
    packHashHex = published.manifestHashHex;
    report?.("Signing tip (ChunkedPack)…");
    signed = await nativeSignPush({
      prefix: input.prefix,
      stateHex,
      sizeBytes: published.totalSize,
      refName,
      tipHex: tipHashHex,
      manifestHashHex: published.manifestHashHex,
      chunkCount: published.chunkCount,
    });
  } else {
    const packHash = blake3(packBytes);
    packHashHex = bytesToHex(packHash);
    report?.("Putting pack…");
    const packWasm = await loadPackWasm();
    const packKey = packContractKey(packHashHex);
    const packPut = buildPutRequest(
      packWasm,
      PACK_WASM_HASH_B58,
      packHash,
      packBytes,
    );
    await withWriteTimeout(putContract(packPut, packKey), "pack Put");

    report?.("Signing tip…");
    signed = await nativeSignPush({
      prefix: input.prefix,
      stateHex,
      packHashHex,
      sizeBytes: packBytes.byteLength,
      refName,
      tipHex: tipHashHex,
    });
  }

  const repoKey = repoContractKey(input.prefix);
  const mergedState = hexDecode(signed.state_hex);
  const repoWasm = await loadRepoWasm();
  const params = encodeRepoParams(input.prefix);

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // await updateContract(wrapDeltaUpdate(repoKey, delta), repoKey);
  // hangs: stdlib "Request timeout" (~30s) — same as ForgeVault/ForgeRegistry.
  // NEW CODE - TESTING: Put full merged RepoState; Update delta only as fallback
  try {
    const putReq = buildPutRequest(
      repoWasm,
      REPO_WASM_HASH_B58,
      params,
      mergedState,
    );
    await withWriteTimeout(putContract(putReq, repoKey), "repo tip Put");
  } catch (putErr) {
    console.warn(
      "[freenet-push] tip Put failed, trying Update:",
      putErr instanceof Error ? putErr.message : putErr,
    );
    await primeRepoHosting(input.prefix);
    const delta = hexDecode(signed.delta_hex);
    await withWriteTimeout(
      updateContract(wrapDeltaUpdate(repoKey, delta), repoKey),
      "repo tip Update",
    );
  }

  clearRepoStateCache(input.prefix);
  clearRepoTipCaches(input.prefix);
  // NEW CODE - TESTING: soft UI refresh (SPA) — avoid location.assign 404 wait
  const { notifyRepoTipPushed } = await import("./tip-cache-lifecycle");
  notifyRepoTipPushed(input.prefix);
  // Protect tip membership sync (ProtectWorker also listens)
  void import("./protect-tip-sync")
    .then((m) => m.syncRepoProtectAfterTipPush(input.prefix))
    .catch((e) =>
      console.warn(
        "[freenet-push] protect tip sync:",
        e instanceof Error ? e.message : e,
      ),
    );
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const { ensureBackupTipPushListener, enqueueBackupRefreshAfterTipPush } =
  //   await import("./repo-backup");
  // ensureBackupTipPushListener();
  // void enqueueBackupRefreshAfterTipPush(input.prefix);
  const { ensureOwnerProvisionTipListener, enqueueOwnerRepoProvision } =
    await import("./forge-repo");
  ensureOwnerProvisionTipListener();
  enqueueOwnerRepoProvision(input.prefix);

  return { tipHashHex, packHashHex, refName };
}

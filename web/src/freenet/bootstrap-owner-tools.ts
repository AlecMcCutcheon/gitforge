/**
 * Cold-peer bootstrap: install forge-identity / forge-pages delegates from
 * website-hosted WASM, then soft-Put singleton contracts (registry / stars).
 *
 * Peers that only fetched the GitForge website never ran `fdev publish … delegate`.
 * Without RegisterDelegate, CreateIdentity / GetIdentity time out on the WS.
 */

import { blake3 } from "@noble/hashes/blake3";
import {
  DelegateRequest,
  type DelegateResponse,
} from "@freenetorg/freenet-stdlib";
import {
  FORGE_IDENTITY_CODE_HASH_BYTES,
  FORGE_IDENTITY_KEY_BYTES,
  forgeOwnerContractsReady,
  forgeStarsReady,
} from "./owner-constants";
import {
  FORGE_PAGES_CODE_HASH_BYTES,
  FORGE_PAGES_KEY_BYTES,
  forgePagesReady,
} from "./pages-constants";
import { loadPublicWasm, resolvePublicAssetUrl } from "./wasm-cache";
import {
  getFreenetApi,
  onDelegateResponseRaw,
  onFreenetHostError,
} from "./ws";

export type BootstrapStatusFn = (msg: string) => void;

let bootstrapOnce: Promise<void> | null = null;
let identityDelegateReady = false;
let pagesDelegateReady = false;

function bytesEqual(a: number[] | Uint8Array, b: number[] | Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function randomCipher32(): number[] {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return Array.from(buf);
}

async function waitForDelegateKey(
  expectedKey: number[],
  timeoutMs: number,
  label: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub();
      unsubErr();
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const unsub = onDelegateResponseRaw((r: DelegateResponse) => {
      const key = r.key?.key;
      if (!key || !bytesEqual(key, expectedKey)) return;
      clearTimeout(timer);
      unsub();
      unsubErr();
      resolve();
    });
    const unsubErr = onFreenetHostError((err) => {
      clearTimeout(timer);
      unsub();
      unsubErr();
      reject(err);
    });
  });
}

async function registerDelegateFromPublicWasm(opts: {
  path: string;
  keyBytes: number[];
  codeHashBytes: number[];
  label: string;
}): Promise<void> {
  const wasm = await loadPublicWasm(opts.path);
  const digest = Array.from(blake3(wasm));
  if (!bytesEqual(digest, opts.codeHashBytes)) {
    throw new Error(
      `${opts.label}: website ${opts.path} BLAKE3 does not match baked code hash — republish owner tools + website`,
    );
  }

  const clientReqModule = await import("@freenetorg/freenet-stdlib/client-request");
  const {
    ClientRequestT,
    ClientRequestType,
    DelegateRequestType,
    DelegateType,
    RegisterDelegateT,
    DelegateContainerT,
    WasmDelegateV1T,
    DelegateCodeT,
    DelegateKeyT,
  } = clientReqModule;

  const code = new DelegateCodeT(Array.from(wasm), opts.codeHashBytes);
  const key = new DelegateKeyT(opts.keyBytes, opts.codeHashBytes);
  // Empty parameters — same as fdev publish without --parameters.
  const wasmDelegate = new WasmDelegateV1T([], code, key);
  const container = new DelegateContainerT(
    DelegateType.WasmDelegateV1,
    wasmDelegate,
  );
  const cipher = randomCipher32();
  const nonce = new Array(24).fill(0);
  const register = new RegisterDelegateT(container, cipher, nonce);
  const delegateReq = new DelegateRequest(
    DelegateRequestType.RegisterDelegate,
    register,
  );
  const clientReq = new ClientRequestT(
    ClientRequestType.DelegateRequest,
    delegateReq,
  );

  const api = await getFreenetApi();
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const pending = waitForDelegateKey(opts.keyBytes, 45_000, opts.label);
  // (api as ...).sendRequest(clientReq);
  // await pending;
  // NEW CODE - TESTING: if ack shape differs, accept a successful GetIdentity probe
  const pending = waitForDelegateKey(opts.keyBytes, 45_000, opts.label);
  (api as unknown as { sendRequest: (r: unknown) => void }).sendRequest(
    clientReq,
  );
  try {
    await pending;
  } catch (err) {
    if (opts.label.includes("forge-identity") && (await probeIdentityDelegate(5_000))) {
      return;
    }
    throw err;
  }
}

/**
 * Probe whether identity delegate answers GetIdentity (any Identity / Error).
 * waitForDelegate rejects Error payloads — treat those as "delegate is alive"
 * unless the failure is a timeout / WS drop / host error.
 */
async function probeIdentityDelegate(timeoutMs = 4_000): Promise<boolean> {
  if (!forgeOwnerContractsReady()) return false;
  try {
    const { sendDelegateMessage } = await import("./delegate-api");
    const { waitForDelegate } = await import("./owner-api");
    const api = await getFreenetApi();
    const pending = waitForDelegate<{ type?: string; message?: string }>(
      (p) => p.type === "Identity" || p.type === "Error",
      timeoutMs,
    );
    await sendDelegateMessage(
      api,
      FORGE_IDENTITY_KEY_BYTES,
      FORGE_IDENTITY_CODE_HASH_BYTES,
      { type: "GetIdentity" },
    );
    await pending;
    return true;
  } catch (err) {
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // return false; // treated "no identity" Error as missing delegate
    // NEW CODE - TESTING
    if (!(err instanceof Error)) return false;
    if (
      /timeout|Connection closed|1006|WebSocket|network|host error/i.test(
        err.message,
      )
    ) {
      return false;
    }
    // Delegate responded (e.g. Error: no identity) — already installed.
    return true;
  }
}

async function ensureIdentityDelegate(
  onStatus?: BootstrapStatusFn,
): Promise<void> {
  if (identityDelegateReady) return;
  if (await probeIdentityDelegate(4_000)) {
    identityDelegateReady = true;
    return;
  }
  onStatus?.("Installing identity tools on this node…");
  console.info(
    "[bootstrap] RegisterDelegate forge-identity from",
    resolvePublicAssetUrl("./hub_identity.wasm"),
  );
  await registerDelegateFromPublicWasm({
    path: "./hub_identity.wasm",
    keyBytes: FORGE_IDENTITY_KEY_BYTES,
    codeHashBytes: FORGE_IDENTITY_CODE_HASH_BYTES,
    label: "forge-identity RegisterDelegate",
  });
  identityDelegateReady = true;
}

async function ensurePagesDelegate(onStatus?: BootstrapStatusFn): Promise<void> {
  if (pagesDelegateReady || !forgePagesReady()) return;
  onStatus?.("Installing Pages tools on this node…");
  try {
    await registerDelegateFromPublicWasm({
      path: "./hub_pages.wasm",
      keyBytes: FORGE_PAGES_KEY_BYTES,
      codeHashBytes: FORGE_PAGES_CODE_HASH_BYTES,
      label: "forge-pages RegisterDelegate",
    });
    pagesDelegateReady = true;
  } catch (err) {
    // Pages is optional for create-identity; log and continue.
    console.warn(
      "[bootstrap] pages delegate install skipped:",
      err instanceof Error ? err.message : err,
    );
  }
}

async function softSeedSingletons(onStatus?: BootstrapStatusFn): Promise<void> {
  try {
    onStatus?.("Seeding ForgeRegistry on this node…");
    const { ensureForgeRegistryExists } = await import("./forge-registry");
    await ensureForgeRegistryExists();
  } catch (err) {
    console.warn(
      "[bootstrap] ForgeRegistry seed:",
      err instanceof Error ? err.message : err,
    );
  }
  if (!forgeStarsReady()) return;
  try {
    const { ensureForgeStarsExists } = await import("./forge-stars");
    await ensureForgeStarsExists();
  } catch (err) {
    console.warn(
      "[bootstrap] ForgeStars seed:",
      err instanceof Error ? err.message : err,
    );
  }
}

let delegatesOnce: Promise<void> | null = null;

/**
 * Install forge-identity (+ pages) delegates from website WASM when missing.
 * Does not Put ForgeRegistry / ForgeStars — use ensureOwnerToolsOnThisNode for that.
 */
export async function ensureOwnerDelegatesOnThisNode(
  onStatus?: BootstrapStatusFn,
): Promise<void> {
  if (!forgeOwnerContractsReady()) {
    throw new Error(
      "GitForge owner tools missing from this website build — ask the publisher to run build:owner and republish",
    );
  }
  if (!delegatesOnce) {
    delegatesOnce = (async () => {
      await ensureIdentityDelegate(onStatus);
      await ensurePagesDelegate(onStatus);
    })().catch((err) => {
      delegatesOnce = null;
      throw err;
    });
  }
  await delegatesOnce;
}

/**
 * Idempotent cold-peer bootstrap. Safe to call from Discover + Account.
 */
export async function ensureOwnerToolsOnThisNode(
  onStatus?: BootstrapStatusFn,
): Promise<void> {
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // if (!bootstrapOnce) {
  //   bootstrapOnce = (async () => {
  //     await ensureIdentityDelegate(onStatus);
  //     await ensurePagesDelegate(onStatus);
  //     await softSeedSingletons(onStatus);
  //   })()...
  // }
  // NEW CODE - TESTING: delegates share a latch; soft-seed runs after
  if (!bootstrapOnce) {
    bootstrapOnce = (async () => {
      await ensureOwnerDelegatesOnThisNode(onStatus);
      await softSeedSingletons(onStatus);
    })().catch((err) => {
      bootstrapOnce = null;
      throw err;
    });
  }
  await bootstrapOnce;
}

/** Fire-and-forget Discover warm-up (no throw to UI). */
export function softBootstrapOwnerTools(): void {
  void ensureOwnerToolsOnThisNode().catch((err) => {
    console.warn(
      "[bootstrap] background owner tools:",
      err instanceof Error ? err.message : err,
    );
  });
}

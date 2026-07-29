/**
 * HubProfile Put → Put (save) roundtrip against local Freenet WS.
 * Usage: npx tsx scripts/test-hub-profile-roundtrip.mts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ed25519 } from "@noble/curves/ed25519";
import { bytesToHex } from "@noble/hashes/utils";
import bs58 from "bs58";
import { HUB_PROFILE_WASM_HASH_B58 } from "../web/src/freenet/owner-constants.ts";
import {
  hubProfileKeyForFingerprint,
  putOrUpdateHubProfile,
  type HubProfileStateJson,
} from "../web/src/freenet/hub-profile.ts";
import { resetFreenetConn } from "../web/src/freenet/ws.ts";

(globalThis as { location?: { protocol: string; host: string } }).location = {
  protocol: "http:",
  host: "127.0.0.1:7509",
};

const SIGN_DOMAIN = new TextEncoder().encode("freenethub.profile.v1\0");

function pushField(out: number[], bytes: Uint8Array): void {
  for (const b of bytes) out.push(b);
  out.push(0);
}

function signingPayload(state: {
  identity_fingerprint: string;
  username: string;
  public_email: string;
  bio: string;
  url: string;
  avatar: string;
  seq: number;
  updated_at: string;
}): Uint8Array {
  const out: number[] = [...SIGN_DOMAIN];
  const enc = new TextEncoder();
  pushField(out, enc.encode(state.identity_fingerprint));
  pushField(out, enc.encode(state.username));
  pushField(out, enc.encode(state.public_email));
  pushField(out, enc.encode(state.bio));
  pushField(out, enc.encode(state.url));
  pushField(out, enc.encode(state.avatar));
  const seq = BigInt(state.seq);
  const le = new Uint8Array(8);
  new DataView(le.buffer).setBigUint64(0, seq, true);
  for (const b of le) out.push(b);
  pushField(out, enc.encode(state.updated_at));
  return new Uint8Array(out);
}

function signState(
  sk: Uint8Array,
  partial: Omit<HubProfileStateJson, "owner_sig" | "schema_version">,
): HubProfileStateJson {
  const base = {
    schema_version: 1,
    ...partial,
    owner_sig: "",
  };
  const payload = signingPayload(base);
  const sig = ed25519.sign(payload, sk);
  return { ...base, owner_sig: bytesToHex(sig) };
}

async function main(): Promise<void> {
  const wasmPath = resolve("web/public/hub_profile.wasm");
  const wasmBytes = readFileSync(wasmPath);
  const origFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("hub_profile.wasm") || url === "./hub_profile.wasm") {
      return new Response(wasmBytes, {
        status: 200,
        headers: { "content-type": "application/wasm" },
      });
    }
    return origFetch(input, init);
  }) as typeof fetch;

  if (!HUB_PROFILE_WASM_HASH_B58) {
    throw new Error("HUB_PROFILE_WASM_HASH_B58 empty");
  }

  const sk = ed25519.utils.randomPrivateKey();
  const vk = ed25519.getPublicKey(sk);
  const fingerprint = `freenet:id:${bs58.encode(vk)}`;
  const key = hubProfileKeyForFingerprint(fingerprint);
  if (!key) throw new Error("no key");

  console.log("fingerprint", fingerprint);
  console.log("contract", key.encode());

  const t0 = Date.now();
  await putOrUpdateHubProfile(
    signState(sk, {
      identity_fingerprint: fingerprint,
      username: "roundtrip-test",
      public_email: "contact-words",
      bio: "",
      url: "",
      avatar: "",
      seq: 1,
      updated_at: new Date().toISOString(),
    }),
  );
  console.log(`Create Put ok in ${Date.now() - t0}ms`);

  const t1 = Date.now();
  await putOrUpdateHubProfile(
    signState(sk, {
      identity_fingerprint: fingerprint,
      username: "roundtrip-test",
      public_email: "contact-words",
      bio: "updated bio",
      url: "https://example.test",
      avatar: "",
      seq: 2,
      updated_at: new Date().toISOString(),
    }),
  );
  console.log(`Save Put ok in ${Date.now() - t1}ms`);

  resetFreenetConn();
  console.log("PASS: HubProfile create+save Put roundtrip");
}

main().catch((err) => {
  console.error("FAIL:", err instanceof Error ? err.message : err);
  resetFreenetConn();
  process.exit(1);
});

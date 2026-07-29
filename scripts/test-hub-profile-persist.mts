/**
 * Prove save Put persists: create → save → reconnect → GET must see new bio/seq.
 * Usage: npx tsx scripts/test-hub-profile-persist.mts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ed25519 } from "@noble/curves/ed25519";
import { bytesToHex } from "@noble/hashes/utils";
import bs58 from "bs58";
import {
  fetchHubProfile,
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

function signState(
  sk: Uint8Array,
  partial: Omit<HubProfileStateJson, "owner_sig" | "schema_version">,
): HubProfileStateJson {
  const enc = new TextEncoder();
  const out: number[] = [...SIGN_DOMAIN];
  for (const f of [
    "identity_fingerprint",
    "username",
    "public_email",
    "bio",
    "url",
    "avatar",
  ] as const) {
    pushField(out, enc.encode(partial[f]));
  }
  const le = new Uint8Array(8);
  new DataView(le.buffer).setBigUint64(0, BigInt(partial.seq), true);
  for (const b of le) out.push(b);
  pushField(out, enc.encode(partial.updated_at));
  return {
    schema_version: 1,
    ...partial,
    owner_sig: bytesToHex(ed25519.sign(new Uint8Array(out), sk)),
  };
}

async function main(): Promise<void> {
  const wasmBytes = readFileSync(resolve("web/public/hub_profile.wasm"));
  const origFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("hub_profile.wasm")) {
      return new Response(wasmBytes, { status: 200 });
    }
    return origFetch(input, init);
  }) as typeof fetch;

  const sk = ed25519.utils.randomPrivateKey();
  const fp = `freenet:id:${bs58.encode(ed25519.getPublicKey(sk))}`;
  const marker = `verify-${Date.now()}`;

  await putOrUpdateHubProfile(
    signState(sk, {
      identity_fingerprint: fp,
      username: "persist-u",
      public_email: "contact",
      bio: "",
      url: "",
      avatar: "",
      seq: 1,
      updated_at: new Date().toISOString(),
    }),
  );
  await putOrUpdateHubProfile(
    signState(sk, {
      identity_fingerprint: fp,
      username: "persist-u",
      public_email: "contact",
      bio: marker,
      url: "https://example.test/saved",
      avatar: "",
      seq: 2,
      updated_at: new Date().toISOString(),
    }),
  );

  resetFreenetConn();
  await new Promise((r) => setTimeout(r, 800));

  const got = await fetchHubProfile(fp, { reliable: true });
  const ok = got?.bio === marker && got?.seq === 2;
  console.log(
    JSON.stringify(
      {
        fingerprint: fp,
        got_bio: got?.bio ?? null,
        got_url: got?.url ?? null,
        got_seq: got?.seq ?? null,
        matches_saved_state: ok,
      },
      null,
      2,
    ),
  );
  resetFreenetConn();
  if (!ok) process.exit(1);
  console.log("PASS: saved HubProfile readable after reconnect");
}

main().catch((err) => {
  console.error("FAIL:", err instanceof Error ? err.message : err);
  resetFreenetConn();
  process.exit(1);
});

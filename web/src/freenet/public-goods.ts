/**
 * Freenet public-goods v1 adapter.
 *
 * This is an interoperability shape, not a shared identity. Each service owns
 * its delegate, key custody, reputation, and signing domains. GitForge can
 * discover an existing service identity and ask that service to sign. An
 * explicit foreground onboarding action may ask the service delegate to create
 * its own identity; GitForge never creates, derives, imports, or exports a
 * service key.
 */
import type { FreenetWsApi } from "@freenetorg/freenet-stdlib";
import {
  getFreenetApi,
  onDelegatePayloads,
  onFreenetConnDrop,
  onFreenetHostError,
} from "./ws";
import { sendDelegateMessage } from "./delegate-api";

export const PUBLIC_GOODS_PROTOCOL = "freenet.public-good.v1" as const;

export type PublicGoodService = "kairos" | "tyche";
export type PublicGoodCapability =
  | "pulse"
  | "observe_stamp"
  | "commit"
  | "reveal"
  | "recovery";

export type PublicGoodIdentity = {
  nodeId: string;
  label: string;
  service: PublicGoodService;
  status: "present";
  owner: "service";
  backend: "service-delegate";
  created?: boolean;
};

export type PublicGoodManifest = {
  protocol: typeof PUBLIC_GOODS_PROTOCOL;
  service: PublicGoodService;
  version: 1;
  capabilities: readonly PublicGoodCapability[];
  identity_policy: {
    owner: "service";
    private_key_custody: "service_delegate";
    background_creation: false;
    foreground_initialization: "EnsureIdentity";
  };
};

type DelegatePayload = {
  type?: string;
  nonce?: string;
  node_id?: string;
  label?: string;
  created?: boolean;
  message?: string;
  [key: string]: unknown;
};

type DelegateSpec = {
  key: number[];
  codeHash: number[];
  manifest: PublicGoodManifest;
};

const KAIROS_CODE_HASH = [
  198, 187, 222, 173, 215, 177, 246, 202, 225, 230, 58, 42, 2, 42, 182,
  28, 178, 67, 93, 134, 212, 17, 134, 73, 91, 215, 38, 109, 112, 150,
  219, 36,
];
const KAIROS_DELEGATE_KEY = [
  71, 236, 156, 62, 216, 89, 248, 138, 12, 78, 190, 202, 107, 121, 79,
  125, 25, 85, 131, 160, 254, 28, 138, 63, 230, 34, 50, 107, 66, 223,
  0, 242,
];
const TYCHE_CODE_HASH = [
  252, 16, 89, 209, 38, 204, 12, 248, 58, 64, 123, 248, 131, 237, 2,
  59, 163, 47, 175, 201, 108, 175, 141, 71, 93, 44, 76, 197, 207, 135,
  25, 237,
];
const TYCHE_DELEGATE_KEY = [
  118, 7, 79, 38, 46, 135, 85, 7, 236, 78, 135, 10, 72, 25, 5, 243, 108,
  125, 30, 198, 36, 4, 113, 103, 9, 217, 216, 217, 180, 167, 174, 185,
];

const SPECS: Record<PublicGoodService, DelegateSpec> = {
  kairos: {
    key: KAIROS_DELEGATE_KEY,
    codeHash: KAIROS_CODE_HASH,
    manifest: {
      protocol: PUBLIC_GOODS_PROTOCOL,
      service: "kairos",
      version: 1,
      capabilities: ["pulse", "observe_stamp"],
      identity_policy: {
        owner: "service",
        private_key_custody: "service_delegate",
        background_creation: false,
        foreground_initialization: "EnsureIdentity",
      },
    },
  },
  tyche: {
    key: TYCHE_DELEGATE_KEY,
    codeHash: TYCHE_CODE_HASH,
    manifest: {
      protocol: PUBLIC_GOODS_PROTOCOL,
      service: "tyche",
      version: 1,
      capabilities: ["pulse", "commit", "reveal", "recovery"],
      identity_policy: {
        owner: "service",
        private_key_custody: "service_delegate",
        background_creation: false,
        foreground_initialization: "EnsureIdentity",
      },
    },
  },
};

export function publicGoodManifest(service: PublicGoodService): PublicGoodManifest {
  return SPECS[service].manifest;
}

function nonce(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function isNoIdentity(payload: DelegatePayload): boolean {
  return payload.type === "Error" && /no identity|identity missing/i.test(payload.message || "");
}

async function callServiceDelegate(
  service: PublicGoodService,
  message: Record<string, unknown>,
  timeoutMs = 20_000,
): Promise<DelegatePayload> {
  const api = await getFreenetApi();
  const requestNonce = String(message.nonce || nonce());
  const pending = new Promise<DelegatePayload>((resolve, reject) => {
    let settled = false;
    let unsubscribe = () => {};
    let unsubscribeDrop = () => {};
    let unsubscribeHost = () => {};
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      unsubscribeDrop();
      unsubscribeHost();
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`${service} identity delegate timeout`))),
      timeoutMs,
    );
    unsubscribeDrop = onFreenetConnDrop((error) => finish(() => reject(error)));
    unsubscribeHost = onFreenetHostError((error) => finish(() => reject(error)));
    unsubscribe = onDelegatePayloads((payloads) => {
      for (const payload of payloads) {
        const candidate = payload as DelegatePayload;
        // Every delegate operation is nonce-addressed. Do not attribute an
        // older response (or a response without a nonce) to this request.
        if (candidate.nonce !== requestNonce) continue;
        if (["Identity", "SignedObservation", "Signed", "RecoverySigned", "Error"].includes(candidate.type || "")) {
          finish(() => resolve(candidate));
          return;
        }
      }
    });
    void sendDelegateMessage(
      api,
      SPECS[service].key,
      SPECS[service].codeHash,
      { ...message, nonce: requestNonce },
    ).catch((error: unknown) => finish(() => reject(error)));
  });
  return pending;
}

function identityFromResponse(
  service: PublicGoodService,
  response: DelegatePayload,
): PublicGoodIdentity | null {
  if (!response.node_id || !response.label) return null;
  return {
    nodeId: response.node_id,
    label: response.label,
    service,
    status: "present",
    owner: "service",
    backend: "service-delegate",
    created: response.created === true,
  };
}

/** Read-only lookup. Returns null for a missing service-owned identity. */
export async function getPublicGoodIdentity(
  service: PublicGoodService,
): Promise<PublicGoodIdentity | null> {
  try {
    const response = await callServiceDelegate(service, { type: "GetIdentity", nonce: nonce() });
    if (isNoIdentity(response) || response.type === "Error") return null;
    return identityFromResponse(service, response);
  } catch {
    // A public-good worker must never make GitForge startup depend on another app.
    return null;
  }
}

/**
 * Explicit foreground onboarding only. The service delegate generates and
 * stores the private key; GitForge receives identity metadata, never a key.
 * Background workers must not call this function.
 */
export async function ensurePublicGoodIdentity(
  service: PublicGoodService,
): Promise<PublicGoodIdentity> {
  const response = await callServiceDelegate(service, { type: "EnsureIdentity", nonce: nonce() });
  if (response.type === "Error") {
    throw new Error(response.message || `${service} identity initialization failed`);
  }
  const identity = identityFromResponse(service, response);
  if (!identity) {
    throw new Error(`${service} identity delegate returned an invalid identity`);
  }
  return identity;
}

/**
 * Service-specific signing request. This is intentionally not exported as a
 * generic private-key API: callers receive a signed protocol observation only.
 */
const SIGNING_OPERATIONS: Record<PublicGoodService, readonly string[]> = {
  kairos: ["SignPulse", "SignStampObserve"],
  tyche: ["SignPulse", "SignCommit", "SignReveal", "SignRecoveryShare"],
};

export async function signPublicGood(
  service: PublicGoodService,
  message: Record<string, unknown>,
): Promise<DelegatePayload | null> {
  const operation = typeof message.type === "string" ? message.type : "";
  if (!SIGNING_OPERATIONS[service].includes(operation)) {
    throw new Error(`${service} public-good operation is not an allowed signing operation`);
  }
  const response = await callServiceDelegate(service, message);
  if (response.type === "Error") {
    throw new Error(response.message || `${service} signing failed`);
  }
  return response;
}

export function isPublicGoodDelegateError(error: unknown): boolean {
  return /delegate|identity|connection|websocket|timeout|network/i.test(
    error instanceof Error ? error.message : String(error),
  );
}

export type { FreenetWsApi };

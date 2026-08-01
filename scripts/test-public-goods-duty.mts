/**
 * Unit tests for GitForge public-goods duty readiness and vault-verification
 * semantics.
 *
 * Covers:
 * - serviceDutyAllowed / computeDutyReadiness gate matrix (consent,
 *   background_enabled, fingerprint match, service identity match).
 * - The reload case: after a hard page reload the sandbox often has no session
 *   identity yet, so readiness is blocked until the identity lands, then flips
 *   on again (this is what the onAuthSessionChange re-kick provides).
 * - sameAuthorization exact-match semantics used by vault re-verification.
 *
 * Usage: npx tsx scripts/test-public-goods-duty.mts
 */
import { computeDutyReadiness, serviceDutyAllowed } from "../web/src/freenet/public-goods-duty.ts";
import { sameAuthorization } from "../web/src/freenet/public-goods-consent.ts";
import type { PublicGoodsAuthorization } from "../web/src/freenet/public-goods-consent.ts";

const FORGE_FP = "fp-gitforge-test";
const KAIROS_NODE = "kairos-node-test";
const KAIROS_LABEL = "kairos-fvuvht";
const TYCHE_NODE = "tyche-node-test";
const TYCHE_LABEL = "tyche-ebd2yv";

const KAIROS_ID = { nodeId: KAIROS_NODE, label: KAIROS_LABEL };
const TYCHE_ID = { nodeId: TYCHE_NODE, label: TYCHE_LABEL };

function auth(partial: Partial<PublicGoodsAuthorization> = {}): PublicGoodsAuthorization {
  return {
    service: "kairos",
    gitforge_identity_fingerprint: FORGE_FP,
    service_node_id: KAIROS_NODE,
    service_label: KAIROS_LABEL,
    initialized_at: 1_700_000_000_000,
    consented_at: 1_700_000_000_100,
    background_enabled: true,
    ...partial,
  };
}

const tycheAuth = (partial: Partial<PublicGoodsAuthorization> = {}): PublicGoodsAuthorization =>
  auth({ service: "tyche", service_node_id: TYCHE_NODE, service_label: TYCHE_LABEL, ...partial });

let failures = 0;
function assert(name: string, actual: boolean, expected: boolean): void {
  if (actual === expected) {
    console.log(`  ok  ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL ${name}: expected ${expected}, got ${actual}`);
  }
}

function expectList(name: string, actual: { kairos: boolean; tyche: boolean }, kairos: boolean, tyche: boolean): void {
  if (actual.kairos === kairos && actual.tyche === tyche) {
    console.log(`  ok  ${name} (kairos=${kairos} tyche=${tyche})`);
  } else {
    failures += 1;
    console.error(`FAIL ${name}: got kairos=${actual.kairos} tyche=${actual.tyche}, expected kairos=${kairos} tyche=${tyche}`);
  }
}

console.log("\n== serviceDutyAllowed gate matrix ==");

assert(
  "consent off blocks duty",
  serviceDutyAllowed({
    service: "kairos",
    consent: { kairos: false, tyche: false },
    authorizations: { kairos: auth() },
    forgeFingerprint: FORGE_FP,
    serviceIdentity: KAIROS_ID,
  }),
  false,
);

assert(
  "background_enabled false blocks duty",
  serviceDutyAllowed({
    service: "kairos",
    consent: { kairos: true, tyche: false },
    authorizations: { kairos: auth({ background_enabled: false }) },
    forgeFingerprint: FORGE_FP,
    serviceIdentity: KAIROS_ID,
  }),
  false,
);

assert(
  "fingerprint mismatch blocks duty",
  serviceDutyAllowed({
    service: "kairos",
    consent: { kairos: true, tyche: false },
    authorizations: { kairos: auth({ gitforge_identity_fingerprint: "fp-other" }) },
    forgeFingerprint: FORGE_FP,
    serviceIdentity: KAIROS_ID,
  }),
  false,
);

assert(
  "service node mismatch blocks duty",
  serviceDutyAllowed({
    service: "kairos",
    consent: { kairos: true, tyche: false },
    authorizations: { kairos: auth({ service_node_id: "kairos-node-other" }) },
    forgeFingerprint: FORGE_FP,
    serviceIdentity: KAIROS_ID,
  }),
  false,
);

assert(
  "service label mismatch blocks duty",
  serviceDutyAllowed({
    service: "kairos",
    consent: { kairos: true, tyche: false },
    authorizations: { kairos: auth({ service_label: "kairos-other" }) },
    forgeFingerprint: FORGE_FP,
    serviceIdentity: KAIROS_ID,
  }),
  false,
);

assert(
  "missing authorization blocks duty",
  serviceDutyAllowed({
    service: "kairos",
    consent: { kairos: true, tyche: false },
    authorizations: {},
    forgeFingerprint: FORGE_FP,
    serviceIdentity: KAIROS_ID,
  }),
  false,
);

assert(
  "full match allows duty",
  serviceDutyAllowed({
    service: "kairos",
    consent: { kairos: true, tyche: false },
    authorizations: { kairos: auth() },
    forgeFingerprint: FORGE_FP,
    serviceIdentity: KAIROS_ID,
  }),
  true,
);

console.log("\n== reload case: identity lands after hard reload ==");

const bothOn = { kairos: true, tyche: true };
const bothAuth = { kairos: auth(), tyche: tycheAuth() };

// After a hard reload the sandbox often wipes sessionStorage: no forge
// identity yet, so duty must not run even though consent + records are intact.
expectList(
  "identity not landed yet -> blocked",
  computeDutyReadiness({
    consent: bothOn,
    authorizations: bothAuth,
    forgeFingerprint: null,
    kairosIdentity: KAIROS_ID,
    tycheIdentity: TYCHE_ID,
  }),
  false,
  false,
);

// The onAuthSessionChange re-kick re-runs the gate once currentIdentity()
// lands, at which point contribution continues automatically.
expectList(
  "identity landed -> both resume",
  computeDutyReadiness({
    consent: bothOn,
    authorizations: bothAuth,
    forgeFingerprint: FORGE_FP,
    kairosIdentity: KAIROS_ID,
    tycheIdentity: TYCHE_ID,
  }),
  true,
  true,
);

// Service identity itself also arrives late on cold nodes.
expectList(
  "service identity not landed yet -> blocked",
  computeDutyReadiness({
    consent: bothOn,
    authorizations: bothAuth,
    forgeFingerprint: FORGE_FP,
    kairosIdentity: null,
    tycheIdentity: null,
  }),
  false,
  false,
);

// One service enabled, the other off.
expectList(
  "per-service consent respected",
  computeDutyReadiness({
    consent: { kairos: true, tyche: false },
    authorizations: bothAuth,
    forgeFingerprint: FORGE_FP,
    kairosIdentity: KAIROS_ID,
    tycheIdentity: TYCHE_ID,
  }),
  true,
  false,
);

console.log("\n== sameAuthorization exact-match semantics ==");

assert("exact match true", sameAuthorization(auth(), auth()), true);
assert("fingerprint mismatch false", sameAuthorization(auth({ gitforge_identity_fingerprint: "x" }), auth()), false);
assert("node mismatch false", sameAuthorization(auth({ service_node_id: "x" }), auth()), false);
assert("label mismatch false", sameAuthorization(auth({ service_label: "x" }), auth()), false);
assert("initialized_at mismatch false", sameAuthorization(auth({ initialized_at: 1 }), auth()), false);
assert("consented_at mismatch false", sameAuthorization(auth({ consented_at: 1 }), auth()), false);
assert("background mismatch false", sameAuthorization(auth({ background_enabled: false }), auth()), false);
assert("undefined local false", sameAuthorization(undefined, auth()), false);

console.log("\n" + (failures === 0 ? "PASS: all public-goods duty tests" : `FAIL: ${failures} assertion(s)`));
process.exit(failures === 0 ? 0 : 1);

/**
 * Live smoke test: verifies GitForge actually contributes to Kairos and Tyche
 * when consent + authorization are in place, by running one real duty pass
 * against the local Freenet node.
 *
 * NOTE: this performs REAL contribution writes (a Kairos pulse/observe and a
 * Tyche pulse/commit/reveal) against the live contracts — it is not a dry run.
 *
 * Requires a running node at 127.0.0.1:7509 with the Kairos and Tyche service
 * delegates installed and their identities initialized. Fails when no service
 * identity is available, so it can never silently "PASS" without contributing.
 *
 * Usage: npx tsx scripts/test-public-goods-live.mts
 */
import { getPublicGoodIdentity } from "../web/src/freenet/public-goods";
import { currentIdentity } from "../web/src/freenet/auth-api";
import {
  getPublicGoodsAuthorizations,
  recordPublicGoodsAuthorization,
  setPublicGoodConsent,
} from "../web/src/freenet/public-goods-consent";
import { computeDutyReadiness } from "../web/src/freenet/public-goods-duty";
import { runKairosNetworkDuty } from "../web/src/freenet/kairos-duty";
import { runTycheDuty } from "../web/src/freenet/tyche-duty";
import { resetFreenetConn } from "../web/src/freenet/ws";

(globalThis as { location?: { protocol: string; host: string } }).location = {
  protocol: "http:",
  host: "127.0.0.1:7509",
};

let failures = 0;
function assert(name: string, actual: boolean, extra = ""): void {
  if (actual) {
    console.log(`  ok  ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

async function main(): Promise<void> {
  const forgeIdentity = await currentIdentity();
  if (!forgeIdentity) {
    failures += 1;
    console.error(
      "FAIL forge identity available — sign in on the node first (create/restore a GitForge identity)",
    );
    resetFreenetConn();
    process.exit(1);
  }

  // Foreground-style onboarding: record the approval for the service-owned
  // identity, then enable background contribution. Mirrors the Settings toggle.
  const identities = await Promise.all([
    getPublicGoodIdentity("kairos"),
    getPublicGoodIdentity("tyche"),
  ]);
  const [kairosIdentity, tycheIdentity] = identities;

  if (!kairosIdentity && !tycheIdentity) {
    resetFreenetConn();
    throw new Error(
      "no Kairos/Tyche service identity initialized on this node — initialize one in the GitForge Settings → Public goods panel first",
    );
  }

  // Foreground-style onboarding, mirroring the Settings panel: record the
  // approval, then enable background contribution. Node has no localStorage,
  // so these records live in module memory only and are not visible to the
  // browser app — the duty runs below read the same in-memory path the web
  // worker uses.
  //
  // NOTE: runKairosNetworkDuty / runTycheDuty perform REAL contribution writes
  // (pulse/observe/commit/reveal) against the live contracts.
  if (kairosIdentity) {
    recordPublicGoodsAuthorization(forgeIdentity.fingerprint, kairosIdentity);
    setPublicGoodConsent("kairos", true);
  }
  if (tycheIdentity) {
    recordPublicGoodsAuthorization(forgeIdentity.fingerprint, tycheIdentity);
    setPublicGoodConsent("tyche", true);
  }

  // Read back the ACTUAL recorded state (same path the duty worker uses) so
  // the readiness assertion validates the real end-to-end records, not a
  // hand-built snapshot.
  const authorizations = getPublicGoodsAuthorizations();
  const readiness = computeDutyReadiness({
    consent: { kairos: Boolean(kairosIdentity), tyche: Boolean(tycheIdentity) },
    authorizations,
    forgeFingerprint: forgeIdentity.fingerprint,
    kairosIdentity,
    tycheIdentity,
  });
  assert(
    "duty readiness kairos",
    readiness.kairos === Boolean(kairosIdentity),
    `recorded=${JSON.stringify(authorizations.kairos)}`,
  );
  assert(
    "duty readiness tyche",
    readiness.tyche === Boolean(tycheIdentity),
    `recorded=${JSON.stringify(authorizations.tyche)}`,
  );

  if (kairosIdentity && readiness.kairos) {
    const result = await runKairosNetworkDuty();
    console.log(
      `  Kairos duty: pulsed=${result.pulsed} observed=${result.observed.length} plan=${result.plan?.summary ?? "none"}${result.skipped ? ` skipped=${result.skipped}` : ""}`,
    );
    assert(
      "kairos contribution ran (pulse or observe)",
      result.pulsed || result.observed.length > 0,
      JSON.stringify(result.errors.map((e) => e.error)),
    );
  }

  if (tycheIdentity && readiness.tyche) {
    const result = await runTycheDuty();
    console.log(
      `  Tyche duty: pulsed=${result.pulsed} committed=${result.committed.length} revealed=${result.revealed.length} plan=${result.plan?.summary ?? "none"}${result.skipped ? ` skipped=${result.skipped}` : ""}`,
    );
    assert(
      "tyche contribution ran (pulse/commit/reveal)",
      result.pulsed || result.committed.length > 0 || result.revealed.length > 0,
      JSON.stringify(result.errors.map((e) => e.error)),
    );
  }

  resetFreenetConn();
  console.log(
    failures === 0 ? "PASS: live public-goods contribution verified" : `FAIL: ${failures} assertion(s)`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("FAIL:", err instanceof Error ? err.message : err);
  resetFreenetConn();
  process.exit(1);
});

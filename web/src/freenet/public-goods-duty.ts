/**
 * Pure decision logic for GitForge's contribution to public-good services
 * (Kairos / Tyche). Kept free of browser/node side effects so it can be unit
 * tested directly. GitForge only contributes through the service-owned
 * delegate identity — it never creates, derives, or exports a service key.
 */
import type { PublicGoodService } from "./public-goods";
import type { PublicGoodsAuthorization, PublicGoodsConsent } from "./public-goods-consent";

export type ServiceIdentityLike = { nodeId: string; label: string };

export type DutyReadinessInput = {
  consent: PublicGoodsConsent;
  authorizations: Partial<Record<PublicGoodService, PublicGoodsAuthorization>>;
  forgeFingerprint: string | null;
  kairosIdentity: ServiceIdentityLike | null;
  tycheIdentity: ServiceIdentityLike | null;
};

/**
 * True only when every contribution gate passes for one service:
 * - explicit consent in this browser, AND
 * - a recorded authorization with background contribution enabled, AND
 * - the authorization belongs to the current GitForge identity, AND
 * - the live service-owned identity still matches the approved identity.
 * A reload (null forgeFingerprint / null serviceIdentity) therefore blocks
 * duty until the session identity lands, then re-enables it automatically.
 */
export function serviceDutyAllowed(input: {
  service: PublicGoodService;
  consent: PublicGoodsConsent;
  authorizations: Partial<Record<PublicGoodService, PublicGoodsAuthorization>>;
  forgeFingerprint: string | null;
  serviceIdentity: ServiceIdentityLike | null;
}): boolean {
  const { service, consent, authorizations, forgeFingerprint, serviceIdentity } = input;
  if (!consent[service]) return false;
  if (!forgeFingerprint || !serviceIdentity) return false;
  const auth = authorizations[service];
  return Boolean(
    auth?.background_enabled &&
      auth.gitforge_identity_fingerprint === forgeFingerprint &&
      auth.service_node_id === serviceIdentity.nodeId &&
      auth.service_label === serviceIdentity.label,
  );
}

export function computeDutyReadiness(input: DutyReadinessInput): {
  kairos: boolean;
  tyche: boolean;
} {
  return {
    kairos: serviceDutyAllowed({
      service: "kairos",
      consent: input.consent,
      authorizations: input.authorizations,
      forgeFingerprint: input.forgeFingerprint,
      serviceIdentity: input.kairosIdentity,
    }),
    tyche: serviceDutyAllowed({
      service: "tyche",
      consent: input.consent,
      authorizations: input.authorizations,
      forgeFingerprint: input.forgeFingerprint,
      serviceIdentity: input.tycheIdentity,
    }),
  };
}

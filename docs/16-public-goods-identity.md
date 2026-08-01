# Public-goods participation and identity

GitForge can help keep Kairos and Tyche useful without creating a GitForge-owned
witness key or merging the services' trust domains.

## The v1 boundary

Kairos and Tyche expose the same outer manifest shape:

```json
{
  "protocol": "freenet.public-good.v1",
  "service": "tyche",
  "version": 1,
  "capabilities": ["pulse", "commit", "reveal", "recovery"],
  "identity_policy": {
    "owner": "service",
    "private_key_custody": "service_delegate",
    "background_creation": false,
    "foreground_initialization": "EnsureIdentity"
  }
}
```

The common shape describes a service; it does not make the services share an
identity. Kairos remains the owner of a Kairos witness and Tyche remains the
owner of a Tyche witness. Their age and reliability histories stay separate.

## Identity behavior

- `GetIdentity` is read-only. It returns the existing service identity or an
  error when the delegate has none.
- `EnsureIdentity` is the explicit service-site onboarding operation. It may
  mint a key inside that service's Freenet delegate and never exposes the
  private key.
- GitForge background duty calls `GetIdentity` only. If the service identity is
  absent, GitForge skips that service instead of silently minting a replacement.
- GitForge Settings exposes an explicit **Public goods** onboarding action. A
  user can choose `Initialize service identity`, which sends  `EnsureIdentity` directly to the selected service delegate. The service generates and retains the
  private key; GitForge receives only identity metadata. This is a foreground
  API, not a worker operation.
- The authorization record is also written to the encrypted, owner-signed
  ForgeVault `settings` envelope when the account vault is available. It stores
  the GitForge fingerprint, service identity node ID/label, initialization and
  consent timestamps, and the background-duty flag — never a service secret.
- Vault restore rehydrates this record for the matching GitForge identity only
  after checking the live service delegate's identity. A missing or changed
  service identity clears active local consent and pauses duty; restore never
  calls `EnsureIdentity` automatically. Older vaults without this field remain
  compatible, but their browser-local preference alone cannot start a worker.
- After initialization, the user separately enables per-service background
  contribution. That consent is persisted locally as an app preference and is
  honored by the worker; disabling it stops future duty without deleting the
  service identity. Local consent is a policy/UX boundary, not cryptographic
  proof of a user gesture, because Freenet delegates currently cannot inspect
  browser click context.
- Signing requests go to the pinned service delegate. GitForge receives only a
  signed pulse, stamp observation, commit, or reveal.
- A duty worker never opens or closes application work, opens recovery, or
  changes consensus rules.

This makes it safe for another app to participate: it can discover a service's
capabilities and existing identity, then invoke the same explicit foreground
`EnsureIdentity` operation when its user opts in, followed by bounded
service-specific duty. The service delegate remains the owner and custody
boundary in every case.

## GitForge workers

In website mode GitForge mounts delayed, non-blocking workers for both
services. Each service starts only after its service-owned identity has been
initialized and the user has explicitly enabled contribution in Settings.
Kairos duty pulses and observes eligible open stamps. Tyche duty pulses and
contributes to already-open rounds when the existing Tyche identity is aged and
its commit secret can be durably stored. It reveals only when the contract says
that identity is next in the reveal order.

If the local node, contract, delegate, or storage is unavailable, the worker
skips or reports the bounded failure and the GitForge shell continues loading.
It does not fall back to a GitForge-derived identity.

See:

- [Kairos public-goods hosting](../../kairos/docs/public-goods.md)
- [Tyche public-goods hosting](../../tyche/docs/public-goods.md)
- [Kairos identity docs](../../kairos/docs/identity.md)

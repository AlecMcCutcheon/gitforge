# GitForge CLI (`gitforge`)

One entry point, same idea as `freenet-git` (subcommands under a single binary).

```text
gitforge vault …   # ForgeVault via scoped API key
gitforge repo  …   # Registry / RepoState via identity bundle
gitforge pages …   # Pages website create / update / disable / url
```

(`gitatlas` is a deprecated shim that forwards to `gitforge`.)

## Install

From `freenet-gitforge` root:

```sh
npm run install:cli    # npm link → `gitforge` on PATH
# or without linking:
npm run gitforge -- help
```

Requires Node and a reachable Freenet node for Freenet ops.

## Vault (API key)

```sh
gitforge vault sync-bundle \
  --api-key "$GATK" \
  --bundle ~/path/to/git-identity.bundle \
  --bundle-passphrase '…'

gitforge vault pull-bundle \
  --api-key "$GATK" \
  --bundle ~/path/to/git-identity.bundle \
  --bundle-passphrase '…'
```

Mint API keys in Settings → API keys with the **repos** scope.

## Repo (identity bundle)

```sh
gitforge repo about \
  --bundle ~/path/to/git-identity.bundle \
  --bundle-passphrase '…' \
  --prefix 7FMQGtHpkidg \
  --label gitforge \
  --description 'Git forge for Freenet — tip-pack browse without a central server.'

gitforge repo register --bundle … --prefix … --label …
gitforge repo unregister --bundle … --prefix …
gitforge repo rename --bundle … --prefix … --name NewName
gitforge repo delete --bundle … --prefix …
```

## Pages (identity bundle)

```sh
gitforge pages create \
  --bundle ~/path/to/git-identity.bundle \
  --bundle-passphrase '…' \
  --prefix 6zkX4rgEkxD6 \
  --label pages-test \
  --branch main

gitforge pages update  --bundle … --prefix … --label …
gitforge pages disable --bundle … --prefix … --label …
gitforge pages url     --bundle … --prefix … --label …
gitforge pages status  --bundle … --prefix … --label …
```

`create` = enable (Put website from tip). `update` = sync. Requires registry
ownership and a live pages-delegate on the node.

## API key scopes

| Scope | Envelope |
| --- | --- |
| `repos` | Repo keys (CLI vault sync) |
| `pages` | Pages website signing keys |
| `settings` | Settings / Protect prefs |

Discover register / about / rename need `gitforge repo … --bundle`.

## How freenet-git builds its CLI

`freenet-git` is a Cargo binary with `clap` subcommands. GitForge stays on
TypeScript so it can reuse the web vault/crypto modules; `npm` `bin` + `tsx`
is the install path until a native binary is warranted.

See also [`docs/14-cli-vault-sync.md`](../../docs/14-cli-vault-sync.md) and
[`docs/09-hub-pages.md`](../../docs/09-hub-pages.md).

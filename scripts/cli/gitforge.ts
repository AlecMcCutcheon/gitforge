#!/usr/bin/env -S npx --yes tsx
/**
 * GitForge unified CLI — same spirit as `freenet-git` (one binary, subcommands).
 *
 *   gitforge vault sync-bundle|pull-bundle …
 *   gitforge repo about|register|unregister|rename|delete …
 *
 * Install (from freenet-gitforge root):
 *   npm link
 *   # or: npm install -g .
 *
 * Requires Node + Freenet node for Freenet ops.
 */
import { brand } from "./brand.ts";
import { runVaultCli } from "./gitforge-vault.ts";
import { runRepoCli } from "./gitforge-repo.ts";

function usage(): never {
  console.error(`${brand.cliName} — ${brand.displayName} CLI (vault + repo owner ops)

Usage:
  ${brand.cliName} vault <sync-bundle|pull-bundle> [options]
  ${brand.cliName} repo  <about|register|unregister|rename|delete> [options]
  ${brand.cliName} help

Vault (API key — vault envelope sync):
  ${brand.cliName} vault sync-bundle --api-key "$GATK" --bundle ./git-identity.bundle
  ${brand.cliName} vault pull-bundle  --api-key "$GATK" --bundle ./git-identity.bundle

Repo (identity bundle — registry / RepoState; not API-key-only):
  ${brand.cliName} repo about --bundle … --prefix … --description '…'
  ${brand.cliName} repo register|unregister|rename|delete …

Scopes on mintable API keys (Settings → API keys):
  repos     — vault repo-key envelope (CLI vault sync)
  pages     — Pages signing keys envelope
  settings  — settings prefs envelope

Discover register / about / rename need the identity bundle (dual-sig),
not vault API keys. See scripts/cli/README.md.
`);
  process.exit(2);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const group = argv[0];
  if (!group || group === "-h" || group === "--help" || group === "help") {
    usage();
  }
  const rest = argv.slice(1);
  if (group === "vault") {
    await runVaultCli(rest);
    return;
  }
  if (group === "repo") {
    await runRepoCli(rest);
    return;
  }
  console.error(`unknown group: ${group} (expected vault | repo)`);
  usage();
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .then(() => process.exit(0));

#!/usr/bin/env npx tsx
/**
 * GitForge repo CLI — registry + RepoState owner ops via local identity delegate.
 *
 * Registry dual-sig and RepoState Put/Update need the owner identity on the
 * local Freenet node (not vault API-key ops alone). This tool opens your
 * freenet-git identity bundle, ImportIdentity + ImportRepoKey, then calls the
 * same owner-api paths as the SPA. Repo meta is ensured on register/about.
 *
 *   gitforge repo about --prefix … --label … --description '…'
 *   gitforge repo register --prefix … --label …
 *   gitforge repo unregister --prefix …
 *   gitforge repo rename --prefix … --name …
 *   gitforge repo delete --prefix …
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { brand } from "./brand.ts";
import { openFreenetGitIdentityBundle } from "../../web/src/freenet/freenet-git-bundle.ts";
import {
  nativeImportIdentity,
  nativeImportRepoKey,
  nativeRegisterRepo,
  nativeRenameRepo,
  nativeSoftDeleteRepo,
  nativeUnregisterRepo,
  nativeUpdateRepoAbout,
} from "../../web/src/freenet/owner-api.ts";
import { ensureForgeRepoMeta } from "../../web/src/freenet/forge-repo.ts";
import { fetchForgeRegistry } from "../../web/src/freenet/forge-registry.ts";
import { resetFreenetConn } from "../../web/src/freenet/ws.ts";

function usage(): never {
  console.error(`Usage:
  ${brand.cliName} repo about      --prefix <p> --label <l> --description <text> [options]
  ${brand.cliName} repo register  --prefix <p> --label <l> [options]
  ${brand.cliName} repo unregister --prefix <p> [options]
  ${brand.cliName} repo rename    --prefix <p> --name <display> [options]
  ${brand.cliName} repo delete    --prefix <p> [options]

  about / register options:
  --description <text>     About / RepoState description (max 350)
  --website <url>          Registry website (Discover)
  --topics <a,b,c>         Registry topics (comma-separated)
  --name <display>         Display name (register / about)

Shared options:
  --bundle <path>            freenet-git identity bundle (required)
  --bundle-passphrase <pw>   Bundle passphrase (or FREENET_GIT_PASSPHRASE)
  --ws <url>                 Freenet command WS URL

Environment:
  FREENET_GIT_PASSPHRASE
  VITE_FREENET_WS_URL / FREENET_WS_URL

Notes:
  Requires a running Freenet node with the identity delegate. Opens the bundle, imports
  identity + matching repo key into the local delegate, then runs the op.
  register / about also ensure repo meta when missing.
  Vault API keys cannot dual-sign the registry — use identity bundle here.
`);
  process.exit(2);
}

function argValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  return argv[i + 1];
}

function requireArg(argv: string[], name: string): string {
  const v = argValue(argv, name)?.trim();
  if (!v) {
    console.error(`missing ${name}`);
    usage();
  }
  return v;
}

function parseTopics(raw: string | undefined): string[] | undefined {
  if (raw == null) return undefined;
  const parts = raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  return parts;
}

async function ensureLocalOwner(opts: {
  bundlePath: string;
  bundlePassphrase: string;
  prefix: string;
}): Promise<{ fingerprint: string; label: string }> {
  const bytes = new Uint8Array(readFileSync(resolve(opts.bundlePath)));
  const opened = openFreenetGitIdentityBundle(bytes, opts.bundlePassphrase);
  console.error(`Identity ${opened.fingerprint}`);

  await nativeImportIdentity(
    opened.secret_key_hex,
    opened.name || "git",
    opened.email || "git@localhost",
  );

  const repo = opened.repos.find((r) => r.prefix === opts.prefix);
  if (!repo) {
    throw new Error(
      `prefix ${opts.prefix} not in bundle (have: ${opened.repos
        .map((r) => r.prefix)
        .join(", ") || "none"})`,
    );
  }
  await nativeImportRepoKey(repo.prefix, repo.secret_hex, repo.label);
  console.error(`Imported repo key ${repo.prefix.slice(0, 12)}… (${repo.label})`);
  return { fingerprint: opened.fingerprint, label: repo.label || opts.prefix };
}

async function cmdAbout(argv: string[]): Promise<void> {
  const prefix = requireArg(argv, "--prefix");
  const label = argValue(argv, "--label")?.trim();
  const description = requireArg(argv, "--description");
  const websiteProvided = argv.includes("--website");
  const topicsProvided = argv.includes("--topics");
  const website = websiteProvided
    ? argValue(argv, "--website")?.trim() || null
    : undefined;
  const topics = topicsProvided
    ? parseTopics(argValue(argv, "--topics")) ?? []
    : undefined;
  const name = argValue(argv, "--name")?.trim() || null;
  const bundlePath = requireArg(argv, "--bundle");
  const bundlePassphrase =
    argValue(argv, "--bundle-passphrase") ||
    process.env.FREENET_GIT_PASSPHRASE ||
    "";
  if (!bundlePassphrase) {
    console.error("missing --bundle-passphrase / FREENET_GIT_PASSPHRASE");
    usage();
  }

  const local = await ensureLocalOwner({
    bundlePath,
    bundlePassphrase,
    prefix,
  });
  const useLabel = label || local.label;

  // Preserve existing website/topics when flags omitted
  let websiteOut = website;
  let topicsOut = topics;
  try {
    const { repos } = await fetchForgeRegistry();
    const live = repos.find((r) => r.repo_prefix === prefix);
    if (websiteOut === undefined) websiteOut = live?.website ?? null;
    if (topicsOut === undefined) topicsOut = live?.topics ?? [];
  } catch {
    if (websiteOut === undefined) websiteOut = null;
    if (topicsOut === undefined) topicsOut = [];
  }

  const result = await nativeUpdateRepoAbout({
    prefix,
    label: useLabel,
    name,
    description,
    website: websiteOut ?? null,
    topics: topicsOut ?? [],
  });
  try {
    await ensureForgeRepoMeta(prefix);
  } catch (e) {
    console.warn(
      "ForgeRepoMeta ensure skipped:",
      e instanceof Error ? e.message : e,
    );
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        description: result.description,
        registration: {
          prefix: result.registration.repo_prefix,
          label: result.registration.label,
          name: result.registration.name,
          description: result.registration.description,
          website: result.registration.website,
          topics: result.registration.topics,
        },
      },
      null,
      2,
    ),
  );
}

async function cmdRegister(argv: string[]): Promise<void> {
  const prefix = requireArg(argv, "--prefix");
  const label = argValue(argv, "--label")?.trim();
  const description = argValue(argv, "--description")?.trim();
  const website = argValue(argv, "--website")?.trim() || null;
  const topics = parseTopics(argValue(argv, "--topics")) ?? [];
  const name = argValue(argv, "--name")?.trim();
  const bundlePath = requireArg(argv, "--bundle");
  const bundlePassphrase =
    argValue(argv, "--bundle-passphrase") ||
    process.env.FREENET_GIT_PASSPHRASE ||
    "";
  if (!bundlePassphrase) {
    console.error("missing --bundle-passphrase / FREENET_GIT_PASSPHRASE");
    usage();
  }

  const local = await ensureLocalOwner({
    bundlePath,
    bundlePassphrase,
    prefix,
  });
  const entry = await nativeRegisterRepo({
    prefix,
    label: label || local.label,
    name: name || label || local.label,
    description: description || undefined,
    website,
    topics,
  });
  console.log(
    JSON.stringify(
      {
        ok: true,
        registration: {
          prefix: entry.repo_prefix,
          label: entry.label,
          name: entry.name,
          description: entry.description,
          website: entry.website,
          topics: entry.topics,
        },
      },
      null,
      2,
    ),
  );
}

async function cmdUnregister(argv: string[]): Promise<void> {
  const prefix = requireArg(argv, "--prefix");
  const bundlePath = requireArg(argv, "--bundle");
  const bundlePassphrase =
    argValue(argv, "--bundle-passphrase") ||
    process.env.FREENET_GIT_PASSPHRASE ||
    "";
  if (!bundlePassphrase) {
    console.error("missing --bundle-passphrase / FREENET_GIT_PASSPHRASE");
    usage();
  }
  await ensureLocalOwner({ bundlePath, bundlePassphrase, prefix });
  await nativeUnregisterRepo({ prefix });
  console.log(JSON.stringify({ ok: true, unregistered: prefix }, null, 2));
}

async function cmdRename(argv: string[]): Promise<void> {
  const prefix = requireArg(argv, "--prefix");
  const name = requireArg(argv, "--name");
  const description = argValue(argv, "--description")?.trim();
  const bundlePath = requireArg(argv, "--bundle");
  const bundlePassphrase =
    argValue(argv, "--bundle-passphrase") ||
    process.env.FREENET_GIT_PASSPHRASE ||
    "";
  if (!bundlePassphrase) {
    console.error("missing --bundle-passphrase / FREENET_GIT_PASSPHRASE");
    usage();
  }
  await ensureLocalOwner({ bundlePath, bundlePassphrase, prefix });
  const result = await nativeRenameRepo({
    prefix,
    name,
    description: description ?? null,
  });
  try {
    await ensureForgeRepoMeta(prefix);
  } catch (e) {
    console.warn(
      "ForgeRepoMeta ensure skipped:",
      e instanceof Error ? e.message : e,
    );
  }
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
}

async function cmdDelete(argv: string[]): Promise<void> {
  const prefix = requireArg(argv, "--prefix");
  const bundlePath = requireArg(argv, "--bundle");
  const bundlePassphrase =
    argValue(argv, "--bundle-passphrase") ||
    process.env.FREENET_GIT_PASSPHRASE ||
    "";
  if (!bundlePassphrase) {
    console.error("missing --bundle-passphrase / FREENET_GIT_PASSPHRASE");
    usage();
  }
  await ensureLocalOwner({ bundlePath, bundlePassphrase, prefix });
  await nativeSoftDeleteRepo({ prefix });
  console.log(JSON.stringify({ ok: true, softDeleted: prefix }, null, 2));
}

async function main(argv: string[]): Promise<void> {
  const cmd = argv[0];
  if (!cmd || cmd === "-h" || cmd === "--help") usage();

  const ws =
    argValue(argv, "--ws") ||
    process.env.VITE_FREENET_WS_URL ||
    process.env.FREENET_WS_URL;
  if (ws) {
    process.env.VITE_FREENET_WS_URL = ws;
  }

  try {
    switch (cmd) {
      case "about":
        await cmdAbout(argv);
        break;
      case "register":
        await cmdRegister(argv);
        break;
      case "unregister":
        await cmdUnregister(argv);
        break;
      case "rename":
        await cmdRename(argv);
        break;
      case "delete":
        await cmdDelete(argv);
        break;
      default:
        console.error(`unknown command: ${cmd}`);
        usage();
    }
  } finally {
    resetFreenetConn();
  }
}

/** Programmatic entry (unified `gitforge repo …`). */
export async function runRepoCli(argv: string[]): Promise<void> {
  await main(argv);
}

const isDirectEntry =
  typeof process.argv[1] === "string" &&
  /gitforge-repo(\.ts)?$/.test(process.argv[1].replace(/\\/g, "/"));

if (isDirectEntry) {
  main(process.argv.slice(2))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    })
    .then(() => process.exit(0));
}
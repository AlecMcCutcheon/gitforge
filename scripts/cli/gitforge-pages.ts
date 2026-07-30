#!/usr/bin/env npx tsx
/**
 * GitForge Pages CLI — enable / sync / disable / url via local delegates.
 *
 *   gitforge pages create  --prefix … --label … [--branch main] [--root-path '']
 *   gitforge pages update  --prefix … --label …
 *   gitforge pages disable --prefix … --label … [--no-tombstone]
 *   gitforge pages url     --prefix … --label …
 *   gitforge pages status  --prefix … --label …
 *
 * Requires identity bundle (registry owner) + pages-delegate on the node.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { brand } from "./brand.ts";
import { openFreenetGitIdentityBundle } from "../../web/src/freenet/freenet-git-bundle.ts";
import {
  nativeImportIdentity,
  nativeImportRepoKey,
} from "../../web/src/freenet/owner-api.ts";
import {
  nativePagesDisable,
  nativePagesEnable,
  nativePagesStatus,
  nativePagesSync,
} from "../../web/src/freenet/native-pages.ts";
import { resetFreenetConn } from "../../web/src/freenet/ws.ts";

function usage(): never {
  console.error(`Usage:
  ${brand.cliName} pages create  --prefix <p> --label <l> [options]
  ${brand.cliName} pages update  --prefix <p> --label <l> [options]
  ${brand.cliName} pages disable --prefix <p> --label <l> [options]
  ${brand.cliName} pages url     --prefix <p> --label <l> [options]
  ${brand.cliName} pages status  --prefix <p> --label <l> [options]

create options:
  --branch <name>            Tip branch (default: main)
  --root-path <path>         Publish root under the tip (default: repo root)
  --no-auto-sync             Disable autoSync after create (default: on)

disable options:
  --no-tombstone             Skip tombstone website update (default: tombstone)

Shared options:
  --bundle <path>            freenet-git identity bundle (required)
  --bundle-passphrase <pw>   Bundle passphrase (or FREENET_GIT_PASSPHRASE)
  --ws <url>                 Freenet command WS URL

Environment:
  FREENET_GIT_PASSPHRASE
  VITE_FREENET_WS_URL / FREENET_WS_URL

Notes:
  create = enable (first Put). update = sync tip → website.
  url / status read RepoState pages meta (no mutate).
  Repo must be registered on ${brand.displayName}; pages-delegate must be live.
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

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
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

function printPages(cfg: Awaited<ReturnType<typeof nativePagesStatus>>): void {
  console.log(
    JSON.stringify(
      {
        ok: true,
        enabled: cfg.enabled,
        status: cfg.status,
        siteUrl: cfg.siteUrl,
        contractKey: cfg.contractKey,
        branch: cfg.branch,
        rootPath: cfg.rootPath,
        lastPublishedCommit: cfg.lastPublishedCommit,
        lastPublishedAt: cfg.lastPublishedAt,
        autoSync: cfg.autoSync,
        lastError: cfg.lastError,
      },
      null,
      2,
    ),
  );
}

async function withOwner(
  argv: string[],
): Promise<{ prefix: string; label: string }> {
  const prefix = requireArg(argv, "--prefix");
  const labelArg = argValue(argv, "--label")?.trim();
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
  return { prefix, label: labelArg || local.label };
}

async function cmdCreate(argv: string[]): Promise<void> {
  const { prefix, label } = await withOwner(argv);
  const branch = argValue(argv, "--branch")?.trim() || "main";
  const rootPath = argValue(argv, "--root-path")?.trim() || "";
  const autoSync = !hasFlag(argv, "--no-auto-sync");
  console.error(`Pages create ${prefix}/${label} (branch=${branch} root=${rootPath || "."})`);
  const cfg = await nativePagesEnable(prefix, label, {
    branch,
    rootPath,
    autoSync,
  });
  printPages(cfg);
}

async function cmdUpdate(argv: string[]): Promise<void> {
  const { prefix, label } = await withOwner(argv);
  console.error(`Pages update ${prefix}/${label}`);
  const cfg = await nativePagesSync(prefix, label);
  printPages(cfg);
}

async function cmdDisable(argv: string[]): Promise<void> {
  const { prefix, label } = await withOwner(argv);
  const tombstone = !hasFlag(argv, "--no-tombstone");
  console.error(`Pages disable ${prefix}/${label} (tombstone=${tombstone})`);
  const cfg = await nativePagesDisable(prefix, label, { tombstone });
  try {
    const { clearAboutWebsiteIfMatchesPages } = await import(
      "../../web/src/freenet/pages-about.ts"
    );
    await clearAboutWebsiteIfMatchesPages(prefix, label, cfg);
  } catch {
    /* best-effort */
  }
  printPages(cfg);
}

async function cmdStatus(argv: string[]): Promise<void> {
  const { prefix, label } = await withOwner(argv);
  const cfg = await nativePagesStatus(prefix, label, false);
  printPages(cfg);
}

async function cmdUrl(argv: string[]): Promise<void> {
  const { prefix, label } = await withOwner(argv);
  const cfg = await nativePagesStatus(prefix, label, false);
  console.log(
    JSON.stringify(
      {
        ok: true,
        enabled: cfg.enabled,
        siteUrl: cfg.siteUrl,
        contractKey: cfg.contractKey,
      },
      null,
      2,
    ),
  );
  if (cfg.siteUrl) {
    console.error(cfg.siteUrl);
  } else {
    console.error("Pages not enabled (no site URL)");
  }
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
      case "create":
      case "enable":
        await cmdCreate(argv);
        break;
      case "update":
      case "sync":
        await cmdUpdate(argv);
        break;
      case "disable":
        await cmdDisable(argv);
        break;
      case "url":
        await cmdUrl(argv);
        break;
      case "status":
        await cmdStatus(argv);
        break;
      default:
        console.error(`unknown command: ${cmd}`);
        usage();
    }
  } finally {
    resetFreenetConn();
  }
}

export async function runPagesCli(argv: string[]): Promise<void> {
  await main(argv);
}

const isDirectEntry =
  typeof process.argv[1] === "string" &&
  /gitforge-pages(\.ts)?$/.test(process.argv[1].replace(/\\/g, "/"));

if (isDirectEntry) {
  main(process.argv.slice(2))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    })
    .then(() => process.exit(0));
}

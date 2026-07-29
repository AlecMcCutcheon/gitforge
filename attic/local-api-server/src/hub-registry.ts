import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { ensureCacheRoot } from "./env.js";
import { whoami } from "./freenet-git-ops.js";
import { parseFreenetUrl } from "./urls.js";

export interface HubRegistration {
  schema_version: number;
  repo_prefix: string;
  label: string;
  name: string | null;
  description: string | null;
  identity_fingerprint: string;
  identity_name: string;
  identity_email: string | null;
  /** Bridge attestation until Freenet HubRegistry WASM dual-sig is published. */
  attestation: "local-bundle-v1" | "dual-sig-v1";
  identity_sig?: string | null;
  repo_owner_sig?: string | null;
  seq: number;
  updated_at: string;
}

interface RegistryFile {
  schema_version: number;
  repos: Record<string, HubRegistration>;
}

async function registryPath(): Promise<string> {
  const reposRoot = await ensureCacheRoot();
  const root = path.dirname(reposRoot);
  await fs.mkdir(root, { recursive: true });
  return path.join(root, "hub-registry.json");
}

async function loadRegistry(): Promise<RegistryFile> {
  const file = await registryPath();
  try {
    const raw = await fs.readFile(file, "utf8");
    const data = JSON.parse(raw) as RegistryFile;
    if (!data.repos || typeof data.repos !== "object") {
      return { schema_version: 1, repos: {} };
    }
    return { schema_version: 1, repos: data.repos };
  } catch {
    return { schema_version: 1, repos: {} };
  }
}

async function saveRegistry(data: RegistryFile): Promise<void> {
  const file = await registryPath();
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export function parseWhoami(stdout: string): {
  name: string;
  email: string | null;
  fingerprint: string;
  repos: Array<{ prefix: string; label: string }>;
} | null {
  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return null;

  const nameEmail = /^(.+?)\s*<([^>]+)>$/.exec(lines[0]);
  const name = nameEmail ? nameEmail[1].trim() : lines[0];
  const email = nameEmail ? nameEmail[2].trim() : null;
  const fingerprint = lines[1];

  const repos: Array<{ prefix: string; label: string }> = [];
  for (const line of lines) {
    const m =
      /freenet::([1-9A-HJ-NP-Za-km-z]+)\/([A-Za-z0-9._~-]+)/.exec(line) ??
      /freenet:([1-9A-HJ-NP-Za-km-z]+)\/([A-Za-z0-9._~-]+)/.exec(line);
    if (m) repos.push({ prefix: m[1], label: m[2] });
  }

  return { name, email, fingerprint, repos };
}

export async function listRegistry(): Promise<HubRegistration[]> {
  const data = await loadRegistry();
  return Object.values(data.repos).sort((a, b) =>
    a.repo_prefix.localeCompare(b.repo_prefix),
  );
}

export async function getRegistration(
  prefix: string,
): Promise<HubRegistration | null> {
  const data = await loadRegistry();
  return data.repos[prefix] ?? null;
}

export async function listByIdentity(
  fingerprint: string,
): Promise<HubRegistration[]> {
  const all = await listRegistry();
  const key = fingerprint.trim().toLowerCase();
  return all.filter(
    (r) => r.identity_fingerprint.toLowerCase() === key,
  );
}

/**
 * Register a repo the local identity owns (whoami registry).
 * One entry per repo_prefix; same identity may update metadata.
 */
export async function registerRepo(input: {
  prefix: string;
  label: string;
  name?: string;
  description?: string;
}): Promise<HubRegistration> {
  const id = await whoami();
  if (!id.ok) {
    throw new Error(id.stderr || "freenet-git whoami failed — create an identity first");
  }
  const parsed = parseWhoami(id.stdout);
  if (!parsed) {
    throw new Error("Could not parse freenet-git whoami output");
  }

  const owned = parsed.repos.find((r) => r.prefix === input.prefix);
  if (!owned) {
    throw new Error(
      `Repo prefix ${input.prefix} is not in your identity bundle registry. Create it with freenet-git create first.`,
    );
  }

  const label = input.label || owned.label;
  const data = await loadRegistry();
  const existing = data.repos[input.prefix];

  if (
    existing &&
    existing.identity_fingerprint !== parsed.fingerprint
  ) {
    throw new Error(
      `Prefix ${input.prefix} is already registered by another identity`,
    );
  }

  const next: HubRegistration = {
    schema_version: 1,
    repo_prefix: input.prefix,
    label,
    name: input.name?.trim() || existing?.name || label,
    description: input.description?.trim() || existing?.description || null,
    identity_fingerprint: parsed.fingerprint,
    identity_name: parsed.name, // bridge legacy; website dual-sig writes empty + HubProfile for display
    identity_email: parsed.email,
    attestation: "local-bundle-v1",
    identity_sig: null,
    repo_owner_sig: null,
    seq: (existing?.seq ?? 0) + 1,
    updated_at: new Date().toISOString(),
  };

  data.repos[input.prefix] = next;
  await saveRegistry(data);
  return next;
}

/** Soft-unregister from local bridge HubRegistry file. */
export async function unregisterRepo(prefix: string): Promise<void> {
  const id = await whoami();
  if (!id.ok) {
    throw new Error(id.stderr || "freenet-git whoami failed — create an identity first");
  }
  const parsed = parseWhoami(id.stdout);
  if (!parsed) {
    throw new Error("Could not parse freenet-git whoami output");
  }
  const data = await loadRegistry();
  const existing = data.repos[prefix];
  if (!existing) return;
  if (existing.identity_fingerprint !== parsed.fingerprint) {
    throw new Error(`Prefix ${prefix} is registered by another identity`);
  }
  delete data.repos[prefix];
  await saveRegistry(data);
}

export function identitySlug(fingerprint: string): string {
  return fingerprint.replace(/[^a-zA-Z0-9._+-]/g, "").slice(0, 48) || "unknown";
}

export function shortEmailHash(email: string | null | undefined): string {
  if (!email) return "????";
  return createHash("sha256").update(email.toLowerCase()).digest("hex").slice(0, 4);
}

export function parseFreenetRemote(remote: string): {
  prefix: string;
  label: string;
} | null {
  try {
    const u = parseFreenetUrl(remote);
    return { prefix: u.prefix, label: u.label };
  } catch {
    return null;
  }
}

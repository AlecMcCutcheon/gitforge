import { runCommand } from "./run.js";
import { parseFreenetUrl } from "./urls.js";

export async function whoami(): Promise<{
  ok: boolean;
  stdout: string;
  stderr: string;
}> {
  const result = await runCommand("freenet-git", ["whoami"], {
    timeoutMs: 15_000,
  });
  return {
    ok: result.code === 0,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

export async function initIdentity(input: {
  name: string;
  email: string;
  passphrase?: string;
  noPassphrase?: boolean;
}): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const args = [
    "init-identity",
    "--name",
    input.name,
    "--email",
    input.email,
  ];
  const env: NodeJS.ProcessEnv = {};

  if (input.noPassphrase) {
    args.push("--no-passphrase");
  } else if (input.passphrase) {
    env.FREENET_GIT_PASSPHRASE = input.passphrase;
  } else {
    return {
      ok: false,
      stdout: "",
      stderr:
        "Provide a passphrase, or set noPassphrase for an unencrypted local bundle",
    };
  }

  const result = await runCommand("freenet-git", args, {
    env,
    timeoutMs: 60_000,
  });
  return {
    ok: result.code === 0,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

export async function createRepo(input: {
  name: string;
  description?: string;
}): Promise<{ ok: boolean; stdout: string; stderr: string; url?: string }> {
  const args = ["create", "--name", input.name];
  if (input.description) {
    args.push("--description", input.description);
  }
  const result = await runCommand("freenet-git", args, { timeoutMs: 120_000 });
  const combined = `${result.stdout}\n${result.stderr}`;
  const urlMatch =
    /freenet:([1-9A-HJ-NP-Za-km-z]+)\/([A-Za-z0-9._~-]+)/.exec(combined) ??
    /freenet::([1-9A-HJ-NP-Za-km-z]+)\/([A-Za-z0-9._~-]+)/.exec(combined);

  return {
    ok: result.code === 0,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    url: urlMatch ? `freenet::${urlMatch[1]}/${urlMatch[2]}` : undefined,
  };
}

export async function rescueRepo(rawUrl: string): Promise<{
  ok: boolean;
  stdout: string;
  stderr: string;
}> {
  const url = parseFreenetUrl(rawUrl);
  const result = await runCommand(
    "freenet-git",
    ["rescue", url.display],
    { timeoutMs: 600_000 },
  );
  return {
    ok: result.code === 0,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

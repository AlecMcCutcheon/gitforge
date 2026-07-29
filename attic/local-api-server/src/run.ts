import { spawn } from "node:child_process";

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  stdoutBuffer?: Buffer;
}

export function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    binary?: boolean;
  } = {},
): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const binary = Boolean(options.binary);

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const stdoutChunks: Buffer[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, 2_000);
      if (!settled) {
        settled = true;
        reject(
          new Error(
            `${command} timed out after ${timeoutMs}ms. The Freenet node may be stuck compiling or fetching a contract.`,
          ),
        );
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      if (binary) {
        stdoutChunks.push(chunk);
      } else {
        stdout += chunk.toString("utf8");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        const stdoutBuffer = binary ? Buffer.concat(stdoutChunks) : undefined;
        resolve({
          code,
          stdout: binary ? "" : stdout,
          stderr,
          stdoutBuffer,
        });
      }
    });
  });
}

export function isPeerExhausted(stderr: string, stdout: string): boolean {
  const text = `${stderr}\n${stdout}`.toLowerCase();
  return (
    text.includes("exhausted all peers") ||
    text.includes("get exhausted all peers")
  );
}

export function classifyFreenetError(
  stderr: string,
  stdout: string,
): {
  peerExhausted: boolean;
  wasmExecBlocked: boolean;
  storeLookupFailed: boolean;
  streamTimeout: boolean;
  hint: string | null;
} {
  const text = `${stderr}\n${stdout}`;
  const lower = text.toLowerCase();
  const peerExhausted = isPeerExhausted(stderr, stdout);
  const storeLookupFailed = lower.includes("local store lookup failed");
  const streamTimeout =
    lower.includes("inactivity timeout") ||
    lower.includes("stream assembly") ||
    lower.includes("no fragments received");
  const wasmExecBlocked =
    lower.includes("unable to make memory executable") || storeLookupFailed;

  let hint: string | null = null;
  if (streamTimeout) {
    hint =
      "Freenet pack download timed out while assembling a chunked stream. " +
      "This is common for large/legacy mirrors (e.g. freenet-core). Retry later, " +
      "or browse a smaller history mirror like freenet-stdlib / freenet-git. " +
      "freenet-git has no single-file HTTP API — file view needs successful pack fetch.";
  } else if (storeLookupFailed || wasmExecBlocked) {
    hint =
      "Your Freenet node fetched the contract but failed to compile its WASM " +
      "(unable to make memory executable). On Fedora/Bazzite this usually means " +
      "freenet is running as a *system* systemd service under SELinux domain init_t. " +
      "Fix without disabling SELinux: reinstall as a user service — " +
      "`sudo freenet service uninstall` then `freenet service install` and " +
      "`freenet service start`. Verify with `ps -eZ | grep freenet` (want unconfined_t). " +
      "See docs/04-selinux-wasm-jit.md.";
  } else if (peerExhausted) {
    hint =
      "Peers no longer hold this content. Someone with a hot cache can run `freenet-git rescue`.";
  }

  return {
    peerExhausted,
    wasmExecBlocked,
    storeLookupFailed,
    streamTimeout,
    hint,
  };
}

import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { WebSocket } from "ws";
import { runCommand } from "./run.js";

export const DEFAULT_WS_URL =
  process.env.FREENET_WS_URL ?? "ws://127.0.0.1:7509/v1/contract/command";

export function cacheRoot(): string {
  if (process.env.GITFORGE_CACHE) {
    return path.resolve(process.env.GITFORGE_CACHE);
  }
  return path.join(os.homedir(), ".local", "share", "freenet-hub", "repos");
}

export async function ensureCacheRoot(): Promise<string> {
  const root = cacheRoot();
  await fs.mkdir(root, { recursive: true });
  return root;
}

export async function probeNode(
  wsUrl: string = DEFAULT_WS_URL,
  timeoutMs = 2500,
): Promise<{ ok: boolean; wsUrl: string; detail: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean, detail: string) => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve({ ok, wsUrl, detail });
    };

    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      resolve({
        ok: false,
        wsUrl,
        detail: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const timer = setTimeout(() => {
      finish(false, "timeout waiting for websocket open");
    }, timeoutMs);

    ws.on("open", () => {
      clearTimeout(timer);
      finish(true, "connected");
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      finish(false, err.message);
    });
  });
}

export async function whichTools(): Promise<{
  freenetGit: boolean;
  gitRemoteFreenet: boolean;
  git: boolean;
  fdev: boolean;
  paths: Record<string, string | null>;
}> {
  const check = async (bin: string): Promise<string | null> => {
    const result = await runCommand("sh", ["-c", `command -v ${bin}`], {
      timeoutMs: 5_000,
    });
    const found = result.stdout.trim();
    return result.code === 0 && found ? found : null;
  };

  const [freenetGit, gitRemoteFreenet, git, fdev] = await Promise.all([
    check("freenet-git"),
    check("git-remote-freenet"),
    check("git"),
    check("fdev"),
  ]);

  return {
    freenetGit: Boolean(freenetGit),
    gitRemoteFreenet: Boolean(gitRemoteFreenet),
    git: Boolean(git),
    fdev: Boolean(fdev),
    paths: {
      "freenet-git": freenetGit,
      "git-remote-freenet": gitRemoteFreenet,
      git,
      fdev,
    },
  };
}

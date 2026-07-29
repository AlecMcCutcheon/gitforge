/**
 * Auxiliary WebSocket pool for ChunkedPack chunk GETs.
 *
 * freenet-git (v0.1.11) parallelizes chunk ops across N connections with one
 * in-flight op per socket — FIFO stdlib queues are then safe. The Hub shell WS
 * stays serial for delegates / Puts; this pool is GET-only for tip-browse.
 *
 * See docs/15-freenet-git-ws-hygiene.md.
 */
import {
  ContractKey,
  FreenetWsApi,
  GetRequest,
  type GetResponse,
  type HostError,
  type ResponseHandler,
} from "@freenetorg/freenet-stdlib";

const DEFAULT_POOL_SIZE = 4;
const CONNECT_TIMEOUT_MS = 8_000;
const GET_TIMEOUT_MS = 12_000;

function commandWsUrl(): URL {
  const fromImportMeta = (
    import.meta as ImportMeta & { env?: Record<string, string | undefined> }
  ).env?.VITE_FREENET_WS_URL?.trim();
  const fromProcess =
    typeof process !== "undefined"
      ? process.env?.VITE_FREENET_WS_URL?.trim() ||
        process.env?.FREENET_WS_URL?.trim()
      : undefined;
  const fromEnv = fromImportMeta || fromProcess;
  if (fromEnv) return new URL(fromEnv);
  const loc = (
    globalThis as { location?: { protocol?: string; host?: string } }
  ).location;
  const proto = loc?.protocol === "https:" ? "wss:" : "ws:";
  const host = loc?.host || "127.0.0.1:7509";
  return new URL(`${proto}//${host}/v1/contract/command`);
}

function closeApiSocket(api: FreenetWsApi | null | undefined): void {
  if (!api) return;
  try {
    const ws = (api as unknown as { ws?: WebSocket }).ws;
    if (ws && ws.readyState < 2) ws.close();
  } catch {
    /* ignore */
  }
}

function contractKeyId(key: ContractKey): string {
  try {
    return key.encode();
  } catch {
    return String(key);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

type PoolSlot = {
  api: FreenetWsApi;
  /** Serialize GETs on this socket (FIFO safe when depth ≤ 1). */
  chain: Promise<void>;
  dead: boolean;
};

let slots: PoolSlot[] | null = null;
let opening: Promise<PoolSlot[]> | null = null;
let rr = 0;

function noopHandler(onOpen: () => void, onFail: (err: Error) => void): ResponseHandler {
  return {
    onContractPut: () => {},
    onContractGet: () => {},
    onContractUpdate: () => {},
    onContractUpdateNotification: () => {},
    onContractNotFound: () => {},
    onDelegateResponse: () => {},
    onErr: (err: HostError) => {
      console.warn("[chunk-ws-pool] host error:", err.cause);
    },
    onOpen,
    onClose: (code, reason) => {
      onFail(
        new Error(`chunk pool WS closed: ${code}${reason ? ` ${reason}` : ""}`),
      );
    },
  };
}

async function openOneSlot(): Promise<PoolSlot> {
  let resolveReady!: () => void;
  let rejectReady!: (err: Error) => void;
  let settled = false;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    rejectReady = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
  });

  const slot: PoolSlot = {
    api: null as unknown as FreenetWsApi,
    chain: Promise.resolve(),
    dead: false,
  };

  const handler = noopHandler(
    () => resolveReady(),
    (err) => {
      slot.dead = true;
      rejectReady(err);
    },
  );

  const api = new FreenetWsApi(commandWsUrl(), handler, "");
  slot.api = api;

  const timer = setTimeout(() => {
    rejectReady(new Error(`chunk pool connect timeout (${commandWsUrl()})`));
  }, CONNECT_TIMEOUT_MS);
  try {
    await ready;
  } catch (err) {
    closeApiSocket(api);
    throw err;
  } finally {
    clearTimeout(timer);
  }
  return slot;
}

/**
 * Open up to `want` aux connections; degrade if the node refuses more
 * (freenet-git open_pool pattern). Grow/shrink when calib changes want.
 */
async function ensurePool(want = DEFAULT_POOL_SIZE): Promise<PoolSlot[]> {
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // if (slots && slots.some((s) => !s.dead)) {
  //   return slots.filter((s) => !s.dead);
  // }
  // NEW CODE - TESTING: resize toward want (PAV calib)
  const live = slots?.filter((s) => !s.dead) ?? [];
  if (live.length === want && live.length > 0) {
    return live;
  }
  if (live.length > want && want > 0) {
    const keep = live.slice(0, want);
    const drop = live.slice(want);
    for (const s of drop) {
      s.dead = true;
      closeApiSocket(s.api);
    }
    slots = keep;
    return keep;
  }
  if (live.length > 0 && live.length < want) {
    if (opening) return opening;
    opening = (async () => {
      const opened = [...live];
      for (let i = live.length; i < want; i++) {
        try {
          opened.push(await openOneSlot());
        } catch (err) {
          console.warn(
            `[chunk-ws-pool] grow stopped at ${opened.length}/${want}:`,
            err instanceof Error ? err.message : err,
          );
          break;
        }
      }
      slots = opened;
      return opened;
    })().finally(() => {
      opening = null;
    });
    return opening;
  }

  if (opening) return opening;

  opening = (async () => {
    const opened: PoolSlot[] = [];
    for (let i = 0; i < want; i++) {
      try {
        opened.push(await openOneSlot());
      } catch (err) {
        if (opened.length === 0) throw err;
        console.warn(
          `[chunk-ws-pool] stopped at ${opened.length}/${want} sockets:`,
          err instanceof Error ? err.message : err,
        );
        break;
      }
    }
    slots = opened;
    return opened;
  })().finally(() => {
    opening = null;
  });

  return opening;
}

export function chunkPoolSize(): number {
  if (!slots) return 0;
  return slots.filter((s) => !s.dead).length;
}

/** Close aux sockets (e.g. after tip abort). Shell WS is untouched. */
export function resetChunkWsPool(): void {
  const cur = slots;
  slots = null;
  opening = null;
  rr = 0;
  if (!cur) return;
  for (const s of cur) {
    s.dead = true;
    closeApiSocket(s.api);
  }
}

async function withSlotLock<T>(
  slot: PoolSlot,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = slot.chain;
  let release!: () => void;
  slot.chain = new Promise<void>((r) => {
    release = r;
  });
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * GET contract state on the chunk pool (one in-flight GET per socket).
 * Caller should fall back to shell `getContractState` on failure.
 */
export async function getContractStateOnPool(
  key: ContractKey,
  opts?: { timeoutMs?: number },
): Promise<Uint8Array> {
  const { suggestPoolSize } = await import("./chunk-pool-calib");
  const pool = await ensurePool(suggestPoolSize());
  if (pool.length === 0) {
    throw new Error("chunk WS pool empty");
  }
  const slot = pool[rr++ % pool.length]!;
  if (slot.dead) {
    throw new Error("chunk WS pool slot dead");
  }

  return withSlotLock(slot, async () => {
    const req = new GetRequest(key, false, false, false);
    const label = `chunk-pool GET ${contractKeyId(key).slice(0, 16)}…`;
    const got = await withTimeout(
      slot.api.get(req),
      opts?.timeoutMs ?? GET_TIMEOUT_MS,
      label,
    );
    const res = got as GetResponse;
    if (res.key && contractKeyId(res.key) !== contractKeyId(key)) {
      // FIFO residue on this socket — kill slot; caller may retry elsewhere
      slot.dead = true;
      closeApiSocket(slot.api);
      throw new Error(
        `stale GetResponse key mismatch on chunk pool — slot closed`,
      );
    }
    if (!res.state || res.state.length === 0) {
      throw new Error(`empty state for ${contractKeyId(key)}`);
    }
    return Uint8Array.from(res.state);
  });
}

/** How many parallel chunk workers tip-browse should start. */
export async function preferredChunkConcurrency(): Promise<number> {
  try {
    const { suggestPoolSize } = await import("./chunk-pool-calib");
    const want = suggestPoolSize();
    const pool = await ensurePool(want);
    return Math.max(1, pool.length);
  } catch {
    return 1;
  }
}

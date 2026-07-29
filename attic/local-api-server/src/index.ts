import path from "node:path";
import cors from "cors";
import express from "express";
import { cacheRoot, probeNode, whichTools } from "./env.js";
import {
  createRepo,
  initIdentity,
  rescueRepo,
  whoami,
} from "./freenet-git-ops.js";
import {
  ensureContent,
  inspectRemote,
  listCachedRepos,
  pathExists,
  repoDirFor,
  repoSummary,
  listTree,
} from "./git-ops.js";
import {
  tipArchiveZip,
  tipBinaryExists,
  tipBlame,
  tipListCommits,
  tipListContributors,
  tipListPaths,
  tipListTree,
  tipListBranches,
  tipRawBlob,
  tipReadme,
  tipRepoMeta,
  tipShowBlob,
  tipTagMeta,
} from "./tip-browse.js";
import {
  getRegistration,
  listByIdentity,
  listRegistry,
  registerRepo,
  unregisterRepo,
} from "./hub-registry.js";
import {
  disablePages,
  enablePages,
  getPages,
  maybeAutoSyncPages,
  syncPages,
} from "./hub-pages.js";
import { DEMO_REPOS, parseFreenetUrl } from "./urls.js";

function errorPayload(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  const peerExhausted =
    Boolean((err as { peerExhausted?: boolean }).peerExhausted) ||
    lower.includes("exhausted all peers");
  const wasmExecBlocked =
    Boolean((err as { wasmExecBlocked?: boolean }).wasmExecBlocked) ||
    lower.includes("local store lookup failed") ||
    lower.includes("unable to make memory executable");
  const tipBrowse = Boolean((err as { tipBrowse?: boolean }).tipBrowse);
  const legacyOnly =
    Boolean((err as { legacyOnly?: boolean }).legacyOnly) ||
    lower.includes("tip-browse unsupported");
  const chunkedTimeout =
    Boolean((err as { chunkedTimeout?: boolean }).chunkedTimeout) ||
    lower.includes("inactivity timeout") ||
    lower.includes("no fragments");
  return {
    error: message,
    peerExhausted,
    wasmExecBlocked,
    tipBrowse,
    legacyOnly,
    chunkedTimeout,
  };
}

const app = express();
const port = Number(process.env.FREENET_HUB_PORT ?? 8787);

app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/api/health", async (_req, res) => {
  const [node, tools, tipBrowse] = await Promise.all([
    probeNode(),
    whichTools(),
    tipBinaryExists(),
  ]);
  res.json({
    service: "freenet-hub",
    cacheRoot: cacheRoot(),
    node,
    tools: { ...tools, freenetHubTip: tipBrowse },
    mode: "bridge",
    browseMode: "tip-pack",
  });
});

app.get("/api/demos", (_req, res) => {
  res.json({ demos: DEMO_REPOS });
});

app.get("/api/identity", async (_req, res) => {
  try {
    res.json(await whoami());
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

app.post("/api/identity/init", async (req, res) => {
  try {
    const name = String(req.body?.name ?? "").trim();
    const email = String(req.body?.email ?? "").trim();
    const passphrase =
      typeof req.body?.passphrase === "string" ? req.body.passphrase : undefined;
    const noPassphrase = Boolean(req.body?.noPassphrase);
    if (!name || !email) {
      res.status(400).json({ ok: false, error: "name and email are required" });
      return;
    }
    const result = await initIdentity({
      name,
      email,
      passphrase,
      noPassphrase,
    });
    res.status(result.ok ? 200 : 500).json(result);
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

app.get("/api/cache", async (_req, res) => {
  try {
    res.json({ repos: await listCachedRepos() });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

app.post("/api/repos/inspect", async (req, res) => {
  try {
    res.json(await inspectRemote(String(req.body?.url ?? "")));
  } catch (err) {
    res.status(500).json(errorPayload(err));
  }
});

app.post("/api/repos/ensure", async (req, res) => {
  try {
    const rawUrl = String(req.body?.url ?? "");
    const ensured = await ensureContent(rawUrl);
    const summary = await repoSummary(ensured.path);
    res.json({ ...ensured, summary });
  } catch (err) {
    res.status(500).json(errorPayload(err));
  }
});

app.post("/api/repos/create", async (req, res) => {
  try {
    const name = String(req.body?.name ?? "").trim();
    const description =
      typeof req.body?.description === "string"
        ? req.body.description.trim()
        : undefined;
    if (!name) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // const result = await createRepo({ name, description });
    // res.status(result.ok ? 200 : 500).json(result);
    // NEW CODE - TESTING: freenet-git create, then HubRegistry register
    const result = await createRepo({ name, description });
    if (!result.ok) {
      res.status(500).json(result);
      return;
    }
    let registration = null;
    let registerError: string | null = null;
    const urlMatch = result.url
      ? /freenet::([^/]+)\/(.+)$/.exec(result.url)
      : null;
    if (urlMatch) {
      try {
        registration = await registerRepo({
          prefix: urlMatch[1],
          label: urlMatch[2],
          name,
          description,
        });
      } catch (err) {
        registerError =
          err instanceof Error ? err.message : String(err);
      }
    }
    res.json({ ...result, registration, registerError });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

app.post("/api/repos/rescue", async (req, res) => {
  try {
    const result = await rescueRepo(String(req.body?.url ?? ""));
    res.status(result.ok ? 200 : 500).json(result);
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

/** GitHub-like path API: tip-pack browse (no full clone). */
app.get("/api/r/:prefix/:label", async (req, res) => {
  try {
    const remote = `freenet::${req.params.prefix}/${req.params.label}`;
    // Metadata only — do not block the page on pack downloads.
    const meta = await inspectRemote(remote);
    let name: string | null = null;
    let description: string | null = null;
    try {
      const tipMeta = await tipRepoMeta(req.params.prefix);
      name = tipMeta.name;
      description = tipMeta.description;
    } catch {
      /* bridge still works with refs-only */
    }
    const displayLabel = name || req.params.label;
    res.json({
      ...meta,
      name,
      description,
      remote: `freenet::${req.params.prefix}/${displayLabel}`,
      content: {
        detail:
          "Refs loaded. Code tab uses tip-pack browse (one Freenet pack, not a full clone).",
        action: "tip-browse",
      },
      summary: {
        head: meta.headTarget?.slice(0, 12) ?? "",
        branch: meta.defaultBranch?.replace(/^refs\/heads\//, "") ?? "",
        remotes: [`freenet::${req.params.prefix}/${displayLabel}`],
      },
    });
  } catch (err) {
    res.status(500).json(errorPayload(err));
  }
});

app.get("/api/r/:prefix/:label/tree", async (req, res) => {
  try {
    const ref = typeof req.query.ref === "string" ? req.query.ref : "HEAD";
    const treePath = typeof req.query.path === "string" ? req.query.path : "";
    const result = await tipListTree(req.params.prefix, ref, treePath);
    res.json(result);
  } catch (err) {
    res.status(500).json(errorPayload(err));
  }
});

app.get("/api/r/:prefix/:label/blob", async (req, res) => {
  try {
    const ref = typeof req.query.ref === "string" ? req.query.ref : "HEAD";
    const filePath = typeof req.query.path === "string" ? req.query.path : "";
    if (!filePath) {
      res.status(400).json({ error: "path query required" });
      return;
    }
    const file = await tipShowBlob(req.params.prefix, ref, filePath);
    res.json({
      ref,
      path: file.path,
      content: file.text ?? "",
      contentBase64: file.contentBase64,
      mediaType: file.mediaType,
      size: file.size,
      binary: file.binary,
      tooLarge: file.tooLarge,
      commit: file.commit,
      tipPackSize: file.tipPackSize,
      rawUrl: `/api/r/${encodeURIComponent(req.params.prefix)}/${encodeURIComponent(req.params.label)}/raw?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(filePath)}`,
    });
  } catch (err) {
    res.status(500).json(errorPayload(err));
  }
});

app.get("/api/r/:prefix/:label/raw", async (req, res) => {
  try {
    const ref = typeof req.query.ref === "string" ? req.query.ref : "HEAD";
    const filePath = typeof req.query.path === "string" ? req.query.path : "";
    if (!filePath) {
      res.status(400).json({ error: "path query required" });
      return;
    }
    const { buf, mediaType, filename } = await tipRawBlob(
      req.params.prefix,
      ref,
      filePath,
    );
    res.setHeader("Content-Type", mediaType);
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${filename.replace(/"/g, "")}"`,
    );
    res.send(buf);
  } catch (err) {
    res.status(500).json(errorPayload(err));
  }
});

app.get("/api/r/:prefix/:label/blame", async (req, res) => {
  try {
    const ref = typeof req.query.ref === "string" ? req.query.ref : "HEAD";
    const filePath = typeof req.query.path === "string" ? req.query.path : "";
    if (!filePath) {
      res.status(400).json({ error: "path query required" });
      return;
    }
    const blame = await tipBlame(req.params.prefix, ref, filePath);
    res.json({ ref, ...blame });
  } catch (err) {
    res.status(500).json(errorPayload(err));
  }
});

app.get("/api/r/:prefix/:label/commits", async (req, res) => {
  try {
    const ref = typeof req.query.ref === "string" ? req.query.ref : "HEAD";
    const result = await tipListCommits(req.params.prefix, ref, 50);
    res.json(result);
  } catch (err) {
    res.status(500).json(errorPayload(err));
  }
});

app.get("/api/r/:prefix/:label/branches", async (req, res) => {
  try {
    const remote = `freenet::${req.params.prefix}/${req.params.label}`;
    const meta = await inspectRemote(remote);
    const defaultBranch =
      meta.defaultBranch?.replace(/^refs\/heads\//, "") ?? "main";
    res.json(
      await tipListBranches(req.params.prefix, defaultBranch, meta.refs),
    );
  } catch (err) {
    res.status(500).json(errorPayload(err));
  }
});

app.get("/api/r/:prefix/:label/contributors", async (req, res) => {
  try {
    const ref = typeof req.query.ref === "string" ? req.query.ref : "HEAD";
    const result = await tipListContributors(req.params.prefix, ref);
    res.json(result);
  } catch (err) {
    res.status(500).json(errorPayload(err));
  }
});

app.get("/api/r/:prefix/:label/paths", async (req, res) => {
  try {
    const ref = typeof req.query.ref === "string" ? req.query.ref : "HEAD";
    res.json(await tipListPaths(req.params.prefix, ref));
  } catch (err) {
    res.status(500).json(errorPayload(err));
  }
});

app.get("/api/r/:prefix/:label/archive.zip", async (req, res) => {
  try {
    const ref = typeof req.query.ref === "string" ? req.query.ref : "HEAD";
    const { buf, filename } = await tipArchiveZip(
      req.params.prefix,
      ref,
      req.params.label,
    );
    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename.replace(/"/g, "")}"`,
    );
    res.send(buf);
  } catch (err) {
    res.status(500).json(errorPayload(err));
  }
});

app.get("/api/r/:prefix/:label/tag", async (req, res) => {
  try {
    const name =
      typeof req.query.name === "string" ? req.query.name.trim() : "";
    if (!name) {
      res.status(400).json({ error: "name query required" });
      return;
    }
    res.json(await tipTagMeta(req.params.prefix, name));
  } catch (err) {
    res.status(500).json(errorPayload(err));
  }
});

app.get("/api/r/:prefix/:label/pages", async (req, res) => {
  try {
    const auto =
      req.query.autoSync === "1" || req.query.autoSync === "true";
    if (auto) {
      const synced = await maybeAutoSyncPages(req.params.prefix);
      res.json(
        synced ?? {
          repo_prefix: req.params.prefix,
          label: req.params.label,
          enabled: false,
          status: "off",
          note: "Pages not configured",
        },
      );
      return;
    }
    const row = await getPages(req.params.prefix);
    if (!row) {
      res.json({
        repo_prefix: req.params.prefix,
        label: req.params.label,
        enabled: false,
        autoSync: false,
        branch: "main",
        rootPath: "",
        websiteKeyName: null,
        contractKey: null,
        siteUrl: null,
        lastPublishedCommit: null,
        lastPublishedAt: null,
        status: "off",
        lastError: null,
        version: 0,
      });
      return;
    }
    res.json(row);
  } catch (err) {
    res.status(500).json(errorPayload(err));
  }
});

app.post("/api/r/:prefix/:label/pages/enable", async (req, res) => {
  try {
    const row = await enablePages({
      prefix: req.params.prefix,
      label: req.params.label,
      branch:
        typeof req.body?.branch === "string" ? req.body.branch : undefined,
      rootPath:
        typeof req.body?.rootPath === "string" ? req.body.rootPath : undefined,
      autoSync:
        typeof req.body?.autoSync === "boolean" ? req.body.autoSync : undefined,
    });
    res.json(row);
  } catch (err) {
    res.status(400).json(errorPayload(err));
  }
});

app.post("/api/r/:prefix/:label/pages/sync", async (req, res) => {
  try {
    res.json(await syncPages(req.params.prefix));
  } catch (err) {
    res.status(400).json(errorPayload(err));
  }
});

app.post("/api/r/:prefix/:label/pages/disable", async (req, res) => {
  try {
    res.json(
      await disablePages(req.params.prefix, {
        tombstone: Boolean(req.body?.tombstone),
      }),
    );
  } catch (err) {
    res.status(400).json(errorPayload(err));
  }
});

app.get("/api/registry", async (_req, res) => {
  try {
    res.json({
      repos: await listRegistry(),
      note: "Bridge HubRegistry (local-bundle attestation). Dual-sig Freenet contract comes later.",
    });
  } catch (err) {
    res.status(500).json(errorPayload(err));
  }
});

app.get("/api/registry/:prefix", async (req, res) => {
  try {
    const row = await getRegistration(req.params.prefix);
    if (!row) {
      res.status(404).json({ error: "not registered" });
      return;
    }
    res.json(row);
  } catch (err) {
    res.status(500).json(errorPayload(err));
  }
});

app.get("/api/people/:fingerprint", async (req, res) => {
  try {
    const fingerprint = decodeURIComponent(req.params.fingerprint).trim();
    const repos = await listByIdentity(fingerprint);
    const first = repos[0];
    res.json({
      fingerprint,
      displayName: first?.identity_name ?? fingerprint,
      email: first?.identity_email ?? null,
      repos,
      note: "Hub-registered repos for this identity fingerprint.",
    });
  } catch (err) {
    res.status(500).json(errorPayload(err));
  }
});

app.post("/api/registry/register", async (req, res) => {
  try {
    const prefix = String(req.body?.prefix ?? "").trim();
    const label = String(req.body?.label ?? "repo").trim();
    if (!prefix) {
      res.status(400).json({ error: "prefix required" });
      return;
    }
    const row = await registerRepo({
      prefix,
      label,
      name: typeof req.body?.name === "string" ? req.body.name : undefined,
      description:
        typeof req.body?.description === "string"
          ? req.body.description
          : undefined,
    });
    res.json(row);
  } catch (err) {
    res.status(400).json(errorPayload(err));
  }
});

app.post("/api/registry/unregister", async (req, res) => {
  try {
    const prefix = String(req.body?.prefix ?? "").trim();
    if (!prefix) {
      res.status(400).json({ error: "prefix required" });
      return;
    }
    await unregisterRepo(prefix);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json(errorPayload(err));
  }
});

app.get("/api/r/:prefix/:label/readme", async (req, res) => {
  try {
    const ref = typeof req.query.ref === "string" ? req.query.ref : "HEAD";
    res.json(await tipReadme(req.params.prefix, ref));
  } catch (err) {
    res.status(500).json(errorPayload(err));
  }
});

/** Optional advanced: full clone to disk (not used by Code tab). */
app.post("/api/r/:prefix/:label/clone", async (req, res) => {
  try {
    const remote = `freenet::${req.params.prefix}/${req.params.label}`;
    const ensured = await ensureContent(remote);
    const summary = await repoSummary(ensured.path);
    res.json({ ...ensured, summary });
  } catch (err) {
    res.status(500).json(errorPayload(err));
  }
});

// Legacy cache-key routes kept for older UI
async function resolveDir(id: string): Promise<string> {
  const decoded = decodeURIComponent(id);
  if (decoded.includes("freenet:") || decoded.includes("freenet::")) {
    return repoDirFor(parseFreenetUrl(decoded));
  }
  if (decoded.includes("__")) {
    const dir = path.join(cacheRoot(), decoded);
    if (await pathExists(dir)) return dir;
  }
  return path.join(cacheRoot(), decoded);
}

app.get("/api/repos/:id/tree", async (req, res) => {
  try {
    const dir = await resolveDir(req.params.id);
    const treePath = typeof req.query.path === "string" ? req.query.path : "";
    const ref = typeof req.query.ref === "string" ? req.query.ref : "HEAD";
    res.json({ path: treePath, entries: await listTree(dir, treePath, ref) });
  } catch (err) {
    res.status(500).json(errorPayload(err));
  }
});

app.listen(port, () => {
  console.log(`GitAtlas API listening on http://127.0.0.1:${port}`);
  console.log(`Cache: ${cacheRoot()}`);
});

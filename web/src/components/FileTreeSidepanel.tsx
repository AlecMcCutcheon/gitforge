import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Link } from "../spa-link";
import { repoBlobHref, repoTreeHref, type RepoHrefOpts } from "../lib/repo-path";
import { api } from "../api";

interface TreeNode {
  name: string;
  path: string;
  type: "tree" | "blob";
  children?: TreeNode[];
}

function buildTree(paths: string[]): TreeNode[] {
  const root: TreeNode[] = [];
  const dirMap = new Map<string, TreeNode>();

  const ensureDir = (dirPath: string): TreeNode[] => {
    if (!dirPath) return root;
    const existing = dirMap.get(dirPath);
    if (existing?.children) return existing.children;
    const parts = dirPath.split("/");
    const name = parts[parts.length - 1];
    const parentPath = parts.slice(0, -1).join("/");
    const parentChildren = ensureDir(parentPath);
    const node: TreeNode = {
      name,
      path: dirPath,
      type: "tree",
      children: [],
    };
    dirMap.set(dirPath, node);
    parentChildren.push(node);
    return node.children!;
  };

  for (const filePath of paths) {
    const parts = filePath.split("/").filter(Boolean);
    if (parts.length === 0) continue;
    const fileName = parts[parts.length - 1];
    const dirPath = parts.slice(0, -1).join("/");
    const siblings = ensureDir(dirPath);
    siblings.push({
      name: fileName,
      path: filePath,
      type: "blob",
    });
  }

  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === "tree" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const n of nodes) {
      if (n.children) sortNodes(n.children);
    }
  };
  sortNodes(root);
  return root;
}

function FolderIcon() {
  return (
    <svg className="octicon" viewBox="0 0 16 16" width="14" height="14" aria-hidden>
      <path
        fill="currentColor"
        d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z"
      />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg className="octicon" viewBox="0 0 16 16" width="14" height="14" aria-hidden>
      <path
        fill="currentColor"
        d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5Zm6.75.062V4.25c0 .138.112.25.25.25h2.688l-.011-.013-2.914-2.914-.013-.011Z"
      />
    </svg>
  );
}

function TreeRows({
  nodes,
  depth,
  prefix,
  label,
  branch,
  currentPath,
  openDirs,
  toggleDir,
  ownerOpts,
}: {
  nodes: TreeNode[];
  depth: number;
  prefix: string;
  label: string;
  branch: string;
  currentPath: string;
  openDirs: Set<string>;
  toggleDir: (path: string) => void;
  ownerOpts?: RepoHrefOpts;
}) {
  return (
    <>
      {nodes.map((node) => {
        const active = node.path === currentPath;
        if (node.type === "tree") {
          const open = openDirs.has(node.path);
          // OLD CODE - KEEP UNTIL CONFIRMED WORKING
          // Folder rows only toggled expand — nested browse had no sidepanel
          // highlight / navigation into the folder tree URL.
          // <button type="button" className={`gh-ft-row gh-ft-dir …`} onClick={() => toggleDir(node.path)}>
          // NEW CODE - TESTING: folders link to tree view (same chrome as blob)
          return (
            <li key={`d:${node.path}`}>
              <Link
                className={`gh-ft-row gh-ft-dir ${open ? "open" : ""} ${active ? "active" : ""}`}
                style={{ paddingLeft: 8 + depth * 12 }}
                to={repoTreeHref(prefix, label, branch, node.path, ownerOpts)}
                onClick={() => {
                  if (!open) toggleDir(node.path);
                }}
              >
                <span className="gh-ft-icon">
                  <FolderIcon />
                </span>
                <span className="gh-ft-name">{node.name}</span>
              </Link>
              {open && node.children ? (
                <ul className="gh-ft-list">
                  <TreeRows
                    nodes={node.children}
                    depth={depth + 1}
                    prefix={prefix}
                    label={label}
                    branch={branch}
                    currentPath={currentPath}
                    openDirs={openDirs}
                    toggleDir={toggleDir}
                    ownerOpts={ownerOpts}
                  />
                </ul>
              ) : null}
            </li>
          );
        }
        return (
          <li key={`f:${node.path}`}>
            <Link
              className={`gh-ft-row ${active ? "active" : ""}`}
              style={{ paddingLeft: 8 + depth * 12 }}
              to={repoBlobHref(prefix, label, branch, node.path, ownerOpts)}
            >
              <span className="gh-ft-icon">
                <FileIcon />
              </span>
              <span className="gh-ft-name">{node.name}</span>
            </Link>
          </li>
        );
      })}
    </>
  );
}

export function FileTreeSidepanel({
  prefix,
  label,
  branch,
  currentPath,
  branches,
  ownerOpts,
  branchNav,
}: {
  prefix: string;
  label: string;
  branch: string;
  currentPath: string;
  branches: string[];
  ownerOpts?: RepoHrefOpts;
  /** Override branch-switch navigation (default: same path on blob URL). */
  branchNav?: (branch: string) => string;
}) {
  const navigate = useNavigate();
  const [paths, setPaths] = useState<string[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openDirs, setOpenDirs] = useState<Set<string>>(() => new Set());
  // NEW CODE - TESTING: bump after tip push so Files list includes new paths
  const [pathsRev, setPathsRev] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setError(null);
    void api
      .paths(prefix, label, branch)
      .then((res) => {
        if (cancelled) return;
        setPaths(res.paths);
        // OLD CODE - KEEP UNTIL CONFIRMED WORKING
        // for (let i = 1; i < parts.length; i++) {
        //   dirs.add(parts.slice(0, i).join("/"));
        // }
        // NEW CODE - TESTING: also open the folder itself when browsing a tree path
        const dirs = new Set<string>();
        const parts = currentPath.split("/").filter(Boolean);
        for (let i = 1; i <= parts.length; i++) {
          dirs.add(parts.slice(0, i).join("/"));
        }
        setOpenDirs(dirs);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        // NEW CODE - TESTING: empty / missing tip → empty Files panel (create flow)
        if (
          /empty|no tip|not found|no refs|unknown repo|missing/i.test(message)
        ) {
          setPaths([]);
          setError(null);
          return;
        }
        setError(message);
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [prefix, label, branch, currentPath, pathsRev]);

  useEffect(() => {
    let unsub: (() => void) | null = null;
    let cancelled = false;
    void import("../freenet/tip-cache-lifecycle").then(({ onRepoTipPushed }) => {
      if (cancelled) return;
      unsub = onRepoTipPushed((p) => {
        if (p === prefix) setPathsRev((n) => n + 1);
      });
    });
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [prefix]);

  const tree = useMemo(() => buildTree(paths), [paths]);

  const toggleDir = (path: string) => {
    setOpenDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <aside className="gh-files-panel" aria-label="Files">
      <div className="gh-files-panel-head">Files</div>
      <div className="gh-files-panel-branch">
        <label>
          <span className="visually-hidden">Branch</span>
          <select
            value={branches.includes(branch) ? branch : branches[0] ?? branch}
            onChange={(e) => {
              const b = e.target.value;
              navigate(
                branchNav
                  ? branchNav(b)
                  : repoBlobHref(prefix, label, b, currentPath, ownerOpts),
              );
            }}
          >
            {(branches.length ? branches : [branch]).map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>
      </div>
      {busy ? <p className="muted tiny gh-files-status">Loading…</p> : null}
      {error ? (
        <p className="muted tiny gh-files-status" role="alert">
          {error}
        </p>
      ) : null}
      {!busy && !error ? (
        <ul className="gh-ft-list gh-ft-root">
          <TreeRows
            nodes={tree}
            depth={0}
            prefix={prefix}
            label={label}
            branch={branch}
            currentPath={currentPath}
            openDirs={openDirs}
            toggleDir={toggleDir}
            ownerOpts={ownerOpts}
          />
        </ul>
      ) : null}
    </aside>
  );
}

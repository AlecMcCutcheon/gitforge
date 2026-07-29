/**
 * GitHub-style “upload files” for empty repos.
 * Commit publishes a Freenet tip pack (pack Put + signed RepoState Update).
 */
import { useCallback, useRef, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Link } from "../spa-link";
import { FileTreeSidepanel } from "../components/FileTreeSidepanel";
import { repoHref, type RepoHrefOpts } from "../lib/repo-path";
import { CantEditRepoPanel } from "../components/CantEditRepoPanel";
// OLD CODE - KEEP UNTIL CONFIRMED WORKING
// import { AccessDeniedPanel } from "./NotFoundPage";
import { pushFilesToFreenet } from "../freenet/freenet-push";

interface PendingFile {
  path: string;
  content: string;
  size: number;
}

function isProbablyText(name: string, bytes: Uint8Array): boolean {
  const lower = name.toLowerCase();
  if (
    /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|wasm|bin|exe|dll|so|dylib)$/.test(
      lower,
    )
  ) {
    return false;
  }
  const sample = bytes.subarray(0, Math.min(bytes.length, 8000));
  let weird = 0;
  for (const b of sample) {
    if (b === 0) return false;
    if (b < 7 || (b > 13 && b < 32)) weird += 1;
  }
  return weird / Math.max(sample.length, 1) < 0.05;
}

export function RepoUploadView({
  prefix,
  label,
  remote: _remote,
  ownerOpts,
  isOwner,
  ownershipReady,
  branches = ["main"],
  displayName,
}: {
  prefix: string;
  label: string;
  remote: string;
  ownerOpts?: RepoHrefOpts;
  isOwner: boolean;
  ownershipReady: boolean;
  branches?: string[];
  displayName?: string;
}) {
  const navigate = useNavigate();
  const { branch: branchParam } = useParams();
  const branch = decodeURIComponent(branchParam || "main") || "main";
  const base = repoHref(prefix, label, "", ownerOpts);
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const baseHref = useHref(base);
  const shownName = displayName?.trim() || label;
  const inputRef = useRef<HTMLInputElement>(null);

  const [files, setFiles] = useState<PendingFile[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [subject, setSubject] = useState("Add files via upload");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const addFiles = useCallback(async (list: FileList | File[]) => {
    setError(null);
    const next: PendingFile[] = [];
    for (const file of Array.from(list)) {
      const buf = new Uint8Array(await file.arrayBuffer());
      if (!isProbablyText(file.name, buf)) {
        setError(
          `Skipped binary “${file.name}” — first web push supports text files (use freenet-git for binaries).`,
        );
        continue;
      }
      const content = new TextDecoder().decode(buf);
      const path = file.name.replace(/^\/+/, "").replace(/\\/g, "/");
      if (!path || path.includes("..")) continue;
      next.push({ path, content, size: buf.length });
    }
    if (!next.length) return;
    setFiles((prev) => {
      const map = new Map(prev.map((f) => [f.path, f]));
      for (const f of next) map.set(f.path, f);
      return [...map.values()].sort((a, b) => a.path.localeCompare(b.path));
    });
  }, []);

  const onCancel = () => navigate(base);

  const onCommit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!isOwner) {
      setError("Sign in as the repo owner to commit.");
      return;
    }
    if (!files.length) {
      setError("Choose at least one text file to upload.");
      return;
    }
    setBusy(true);
    setProgress(null);
    void (async () => {
      try {
        await pushFilesToFreenet({
          prefix,
          branch,
          files: files.map((f) => ({ path: f.path, content: f.content })),
          subject: subject.trim() || "Add files via upload",
          description: description.trim() || undefined,
          onProgress: (msg) => {
            setError(null);
            setProgress(msg);
          },
        });
        // OLD CODE - KEEP UNTIL CONFIRMED WORKING
        // navigate(base);
        // window.location.reload();
        // window.location.assign(baseHref); // Freenet deep-path hard-nav → 404 wait
        // NEW CODE - TESTING: SPA navigate; tip push event soft-refetches tree
        navigate(base, { replace: true });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
        setProgress(null);
      }
    })();
  };

  // NEW CODE - TESTING: gate upload UI until owner is confirmed
  if (!ownershipReady) {
    return <p className="muted">Checking access…</p>;
  }
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // if (!isOwner) {
  //   return (
  //     <AccessDeniedPanel
  //       title="Not allowed"
  //       body="Sign in as the repository owner to upload files…"
  //       backHref={base}
  //     />
  //   );
  // }
  // NEW CODE - TESTING: GitHub-like can’t-edit (fork not available yet)
  if (!isOwner) {
    return (
      <div className="gh-blob-layout">
        <FileTreeSidepanel
          prefix={prefix}
          label={label}
          branch={branch}
          currentPath=""
          branches={branches.length ? branches : [branch]}
          ownerOpts={ownerOpts}
        />
        <section className="gh-blob-panel">
          <CantEditRepoPanel backHref={base} />
        </section>
      </div>
    );
  }

  return (
    <div className="gh-blob-layout">
      <FileTreeSidepanel
        prefix={prefix}
        label={label}
        branch={branch}
        currentPath=""
        branches={branches.length ? branches : [branch]}
        ownerOpts={ownerOpts}
        branchNav={(b) =>
          repoHref(prefix, label, `upload/${encodeURIComponent(b)}`, ownerOpts)
        }
      />
      <section className="gh-blob-panel">
        <div className="gh-file-upload">
          <div className="gh-file-create-bar">
            <div className="gh-file-create-path">
              <Link to={base} className="gh-file-create-repo">
                {shownName}
              </Link>
              <span className="gh-file-create-sep">/</span>
              <span className="muted">Upload files</span>
              <span className="gh-file-create-branch muted tiny">
                in {branch}
              </span>
            </div>
            <div className="gh-file-create-actions">
              <button
                type="button"
                className="btn secondary"
                onClick={onCancel}
                disabled={busy}
              >
                Cancel
              </button>
            </div>
          </div>

          <div
            className={`gh-upload-drop${dragOver ? " drag" : ""}`}
            onDragEnter={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              if (e.dataTransfer.files?.length) {
                void addFiles(e.dataTransfer.files);
              }
            }}
          >
            <div className="gh-upload-icon" aria-hidden>
              <svg width="32" height="32" viewBox="0 0 16 16" fill="currentColor">
                <path d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5Zm6.75.22v2.28a.25.25 0 0 0 .25.25h2.28Z" />
              </svg>
            </div>
            <p className="gh-upload-title">
              Drag files here to add them to your repository
            </p>
            <button
              type="button"
              className="gh-upload-choose"
              onClick={() => inputRef.current?.click()}
              disabled={busy}
            >
              Or choose your files
            </button>
            <input
              ref={inputRef}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files?.length) void addFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </div>

          {files.length ? (
            <ul className="gh-upload-list">
              {files.map((f) => (
                <li key={f.path}>
                  <span className="mono">{f.path}</span>
                  <span className="muted tiny">{f.size} B</span>
                  <button
                    type="button"
                    className="btn secondary"
                    disabled={busy}
                    onClick={() =>
                      setFiles((prev) => prev.filter((x) => x.path !== f.path))
                    }
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          <form className="gh-commit-box" onSubmit={onCommit}>
            <h3>Commit changes</h3>
            {error ? <div className="error-banner">{error}</div> : null}
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Add files via upload"
              aria-label="Commit summary"
              disabled={busy}
            />
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Add an optional extended description…"
              rows={3}
              aria-label="Commit description"
              disabled={busy}
            />
            <div className="row">
              <button
                type="submit"
                className="btn"
                disabled={!files.length || busy}
              >
                {busy
                  ? progress || "Publishing to Freenet…"
                  : "Commit changes"}
              </button>
              <button
                type="button"
                className="btn secondary"
                onClick={onCancel}
                disabled={busy}
              >
                Cancel
              </button>
            </div>
            <p className="muted tiny">
              Publishes a tip pack and updates the Freenet repo contract.
            </p>
          </form>
        </div>
      </section>
    </div>
  );
}

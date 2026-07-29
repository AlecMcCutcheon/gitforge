/**
 * GitHub-style “create a new file” for empty repos.
 * Commit publishes a Freenet tip pack (pack Put + signed RepoState Update).
 * Also hosts the post-create first-commit flow (README + optional LICENSE).
 */
import { useEffect, useState } from "react";
import {
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { Link } from "../spa-link";
import ReactMarkdown from "react-markdown";
// OLD CODE - KEEP UNTIL CONFIRMED WORKING
// import remarkGfm from "remark-gfm";
// import rehypeSanitize from "rehype-sanitize";
import { GFM_MARKDOWN_PROPS } from "../lib/gfm-markdown";
import { FileTreeSidepanel } from "../components/FileTreeSidepanel";
import {
  autofillFilePath,
  defaultContentForPath,
  licenseTemplate,
  readmeTemplate,
} from "../lib/starter-files";
import { repoHref, type RepoHrefOpts } from "../lib/repo-path";
import { pushFilesToFreenet } from "../freenet/freenet-push";
import { CantEditRepoPanel } from "../components/CantEditRepoPanel";
import { isMarkdownPath } from "../components/MarkdownPanel";
import { FileCodeEditor } from "../components/FileCodeEditor";
import type { FirstCommitNavState } from "./NewRepoPage";
import { getCachedIdentity } from "../freenet/auth-api";
// OLD CODE - KEEP UNTIL CONFIRMED WORKING
// import { languageHintForPath } from "../lib/starter-files";
// import { AccessDeniedPanel } from "./NotFoundPage";

// OLD CODE - KEEP UNTIL CONFIRMED WORKING
// const GFM_PLUGINS = {
//   remarkPlugins: [remarkGfm],
//   rehypePlugins: [rehypeSanitize],
// };

export function RepoNewFileView({
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
  /** Signed RepoState.name when known. */
  displayName?: string;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const { branch: branchParam } = useParams();
  const [searchParams] = useSearchParams();
  const branch = decodeURIComponent(branchParam || "main") || "main";
  const base = repoHref(prefix, label, "", ownerOpts);
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const baseHref = useHref(base);
  const shownName = displayName?.trim() || label;

  const firstCommit = (location.state as FirstCommitNavState | null)?.firstCommit;
  const starterReadme = Boolean(firstCommit?.addReadme);
  const starterLicenseKey = firstCommit?.licenseKey?.trim() || null;

  const initialName = searchParams.get("filename")?.trim() ?? "";
  const [fileName, setFileName] = useState(() => {
    if (initialName) return initialName;
    if (starterReadme) return "README.md";
    if (starterLicenseKey) return "LICENSE";
    return "";
  });
  const [content, setContent] = useState(() => {
    if (initialName) return defaultContentForPath(initialName, label);
    if (starterReadme) return readmeTemplate(label).content;
    if (starterLicenseKey) {
      return licenseTemplate(starterLicenseKey, {
        project: label,
        fullname: getCachedIdentity()?.name ?? "",
      }).content;
    }
    return "";
  });
  const [companionLicense, setCompanionLicense] = useState<string | null>(
    () => {
      if (starterReadme && starterLicenseKey) {
        return licenseTemplate(starterLicenseKey, {
          project: label,
          fullname: getCachedIdentity()?.name ?? "",
        }).content;
      }
      return null;
    },
  );
  const [subject, setSubject] = useState(() => {
    if (initialName) return `Add ${initialName}`;
    if (starterReadme && starterLicenseKey) return "Initial commit";
    if (starterReadme) return "Add README.md";
    if (starterLicenseKey) return "Add LICENSE";
    return "Create new file";
  });
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [editorTab, setEditorTab] = useState<"edit" | "preview">("edit");
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // Inline .gh-commit-box under the editor (form id="gh-new-file-commit").
  // NEW CODE - TESTING: commit message modal (same as file edit), no inline box
  const [commitModalOpen, setCommitModalOpen] = useState(false);

  useEffect(() => {
    const q = searchParams.get("filename")?.trim() ?? "";
    if (!q) return;
    setFileName(q);
    setContent(defaultContentForPath(q, label));
    setSubject(`Add ${q}`);
  }, [searchParams, label]);

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const lang = useMemo(() => languageHintForPath(fileName.trim()), [fileName]);
  // const showPreview = isMarkdownPath(fileName.trim()) || fileName.trim() === "README";
  // NEW CODE - TESTING: Preview once path has been markdown this session; lock name
  // while Preview + .md; unlock + “renamed without changes” when extension removed.
  const pathIsMarkdown =
    isMarkdownPath(fileName.trim()) || fileName.trim() === "README";
  const [previewAvailable, setPreviewAvailable] = useState(pathIsMarkdown);
  useEffect(() => {
    if (pathIsMarkdown) setPreviewAvailable(true);
  }, [pathIsMarkdown]);
  const showPreviewTab = previewAvailable;
  const nameLocked = editorTab === "preview" && pathIsMarkdown;

  const onNameBlur = () => {
    if (nameLocked) return;
    const filled = autofillFilePath(fileName);
    if (!filled) return;
    setFileName(filled);
    if (!content.trim()) {
      setContent(defaultContentForPath(filled, label));
    }
    if (subject === "Create new file" || subject.startsWith("Add ")) {
      setSubject(`Add ${filled}`);
    }
  };

  const onNameChange = (raw: string) => {
    if (nameLocked) return;
    setNote(null);
    if (editorTab === "preview") {
      // Unlocked non-md preview: allow typing the extension back without autofill
      setFileName(raw);
      return;
    }
    const filled = autofillFilePath(raw);
    if (filled) {
      setFileName(filled);
      if (!content.trim()) {
        setContent(defaultContentForPath(filled, label));
      }
      setSubject(`Add ${filled}`);
      return;
    }
    setFileName(raw);
  };

  const onCancel = () => {
    navigate(base);
  };

  const openCommitModal = () => {
    if (busy) return;
    setError(null);
    setNote(null);
    const path = fileName.trim().replace(/^\/+/, "");
    if (!path || path.includes("..")) {
      setError("Enter a valid file name (e.g. README.md).");
      return;
    }
    if (!isOwner) {
      setError("Sign in as the repo owner to commit.");
      return;
    }
    setCommitModalOpen(true);
  };

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const onCommit = (e: FormEvent) => { e.preventDefault(); … form submit … }
  // NEW CODE - TESTING: commit from modal (no inline form)
  const onCommit = () => {
    setError(null);
    setNote(null);
    if (!isOwner) {
      setError("Sign in as the repo owner to commit.");
      return;
    }
    const path = fileName.trim().replace(/^\/+/, "");
    if (!path || path.includes("..")) {
      setError("Enter a valid file name (e.g. README.md).");
      return;
    }
    setBusy(true);
    void (async () => {
      try {
        const files = [{ path, content }];
        if (
          companionLicense &&
          path.toLowerCase() !== "license" &&
          path.toLowerCase() !== "licence"
        ) {
          files.push({ path: "LICENSE", content: companionLicense });
        }
        const result = await pushFilesToFreenet({
          prefix,
          branch,
          files,
          subject: subject.trim() || `Add ${path}`,
          description: description.trim() || undefined,
        });
        setNote(
          `Published tip ${result.tipHashHex.slice(0, 7)} on ${result.refName}`,
        );
        setCompanionLicense(null);
        setCommitModalOpen(false);
        // OLD CODE - KEEP UNTIL CONFIRMED WORKING
        // navigate(base, { replace: true });
        // window.location.reload();
        // window.location.assign(baseHref); // Freenet deep-path hard-nav → 404 wait
        // NEW CODE - TESTING: SPA navigate; tip push event soft-refetches tree
        navigate(base, { replace: true });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setBusy(false);
      }
    })();
  };

  // NEW CODE - TESTING: gate edit UI until owner is confirmed
  if (!ownershipReady) {
    return <p className="muted">Checking access…</p>;
  }
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // if (!isOwner) { AccessDeniedPanel… }
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
        currentPath={fileName.trim() || ""}
        branches={branches.length ? branches : [branch]}
        ownerOpts={ownerOpts}
        branchNav={(b) =>
          `${repoHref(prefix, label, `new/${encodeURIComponent(b)}`, ownerOpts)}${
            fileName.trim()
              ? `?filename=${encodeURIComponent(fileName.trim())}`
              : ""
          }`
        }
      />
      <section className="gh-blob-panel">
        <div className="gh-file-create">
          {(starterReadme || starterLicenseKey) && (
            <p className="muted tiny" style={{ marginBottom: "0.75rem" }}>
              First commit
              {starterReadme ? " — edit your README" : " — confirm LICENSE"}
              {companionLicense ? " (LICENSE will be included)" : ""}.
            </p>
          )}
          <div className="gh-file-create-bar">
            <div className="gh-file-create-path">
              <Link to={base} className="gh-file-create-repo">
                {shownName}
              </Link>
              <span className="gh-file-create-sep">/</span>
              <input
                className={`gh-file-create-name${nameLocked ? " is-locked" : ""}`}
                value={fileName}
                onChange={(e) => onNameChange(e.target.value)}
                onBlur={onNameBlur}
                placeholder="Name your file…"
                spellCheck={false}
                autoComplete="off"
                aria-label="File name"
                readOnly={nameLocked}
                title={
                  nameLocked
                    ? "Switch to Edit to rename this file"
                    : undefined
                }
                disabled={busy}
              />
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
                Cancel changes
              </button>
              <button
                type="button"
                className="btn"
                onClick={openCommitModal}
                disabled={!fileName.trim() || busy}
              >
                {busy ? "Publishing…" : "Commit changes…"}
              </button>
            </div>
          </div>

          {error && !commitModalOpen ? (
            <div className="error-banner">{error}</div>
          ) : null}
          {note && !commitModalOpen ? <p className="muted">{note}</p> : null}

          <div className="gh-file-create-editor-card">
            {/* OLD CODE - KEEP UNTIL CONFIRMED WORKING
            Separate tabs strip + textarea body.
            <div className="gh-file-create-editor-tabs">…</div>
            <textarea className="gh-file-create-textarea" … />
            */}
            {/* NEW CODE - TESTING: CodeMirror 6 chrome owns Edit|Preview + Spaces|Soft wrap */}
            <FileCodeEditor
              value={content}
              onChange={(next) => {
                setContent(next);
                setNote(null);
              }}
              placeholder="Enter file contents here"
              disabled={busy}
              aria-label="File contents"
              path={fileName.trim() || undefined}
              viewMode={editorTab}
              headerStart={
                <div className="gh-code-editor-tabs" role="group" aria-label="Edit view mode">
                  <button
                    type="button"
                    className={`gh-code-editor-tab${editorTab === "edit" ? " active" : ""}`}
                    onClick={() => setEditorTab("edit")}
                  >
                    Edit
                  </button>
                  {showPreviewTab ? (
                    <button
                      type="button"
                      className={`gh-code-editor-tab${editorTab === "preview" ? " active" : ""}`}
                      onClick={() => setEditorTab("preview")}
                    >
                      Preview
                    </button>
                  ) : null}
                </div>
              }
              preview={
                <div className="md-preview">
                  <ReactMarkdown {...GFM_MARKDOWN_PROPS}>{content}</ReactMarkdown>
                </div>
              }
            />
          </div>

          {/* OLD CODE - KEEP UNTIL CONFIRMED WORKING
          <form id="gh-new-file-commit" className="gh-commit-box" onSubmit={onCommit}>
            <h3>Commit changes</h3>
            …
          </form>
          */}

          {commitModalOpen ? (
            <div
              className="gh-commit-modal-backdrop"
              role="presentation"
              onMouseDown={(e) => {
                if (e.target === e.currentTarget && !busy) {
                  setCommitModalOpen(false);
                }
              }}
            >
              <div
                className="gh-commit-modal"
                role="dialog"
                aria-modal="true"
                aria-labelledby="gh-new-file-commit-title"
                onMouseDown={(e) => e.stopPropagation()}
              >
                <div className="gh-commit-modal-head">
                  <h2 id="gh-new-file-commit-title">Commit changes</h2>
                  <button
                    type="button"
                    className="gh-commit-modal-close"
                    aria-label="Close"
                    disabled={busy}
                    onClick={() => setCommitModalOpen(false)}
                  >
                    ×
                  </button>
                </div>
                <div className="gh-commit-modal-body">
                  {error ? <div className="error-banner">{error}</div> : null}
                  <label className="gh-commit-modal-field">
                    <span className="gh-commit-modal-label">Commit message</span>
                    <input
                      value={subject}
                      onChange={(e) => setSubject(e.target.value)}
                      placeholder={`Add ${fileName.trim() || "file"}`}
                      disabled={busy}
                      autoFocus
                    />
                  </label>
                  <label className="gh-commit-modal-field">
                    <span className="gh-commit-modal-label">
                      Extended description (optional)
                    </span>
                    <textarea
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      placeholder="Add an optional extended description…"
                      rows={3}
                      disabled={busy}
                    />
                  </label>
                  <p className="muted tiny gh-commit-modal-hint">
                    Publishes a tip pack and updates the Freenet repo contract
                    (same path as <span className="mono">git push</span>).
                  </p>
                </div>
                <div className="gh-commit-modal-actions">
                  <button
                    type="button"
                    className="btn secondary"
                    disabled={busy}
                    onClick={() => setCommitModalOpen(false)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={!fileName.trim() || busy}
                    onClick={onCommit}
                  >
                    {busy ? "Publishing…" : "Commit changes"}
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}

/**
 * File / README panels — Preview · Code · Blame plus GitHub-style file actions.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Link } from "../spa-link";
import ReactMarkdown from "react-markdown";
// OLD CODE - KEEP UNTIL CONFIRMED WORKING
// import remarkGfm from "remark-gfm";
// import rehypeSanitize from "rehype-sanitize";
import { GFM_MARKDOWN_PROPS, createGfmMarkdownProps } from "../lib/gfm-markdown";
import { api, type BlameLine } from "../api";
import { freenetRawFileHref } from "../freenet/raw-entry";
import { PageLoadingOverlay } from "./PageLoadingOverlay";
import { CantEditRepoPanel } from "./CantEditRepoPanel";
import { pushFilesToFreenet } from "../freenet/freenet-push";
import { repoBlobHref, repoHref, type RepoHrefOpts } from "../lib/repo-path";
import { FileCodeEditor } from "./FileCodeEditor";

export type FileViewMode = "preview" | "code" | "blame";

export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdown|mkd)$/i.test(path);
}

// OLD CODE - KEEP UNTIL CONFIRMED WORKING
// const GFM_PLUGINS = {
//   remarkPlugins: [remarkGfm],
//   rehypePlugins: [rehypeSanitize],
// };

// OLD CODE - KEEP UNTIL CONFIRMED WORKING (README “View file”)
// function FileLinkIcon() {
//   return (
//     <svg className="octicon" viewBox="0 0 16 16" width="16" height="16" aria-hidden>
//       <path
//         fill="currentColor"
//         d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5Zm6.75.062V4.25c0 .138.112.25.25.25h2.688l-.011-.013-2.914-2.914-.013-.011Z"
//       />
//     </svg>
//   );
// }

function CopyIcon() {
  return (
    <svg className="octicon" viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path
        fill="currentColor"
        d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"
      />
      <path
        fill="currentColor"
        d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"
      />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg className="octicon" viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path
        fill="currentColor"
        d="M2.75 14A1.75 1.75 0 0 1 1 12.25v-2.5a.75.75 0 0 1 1.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 13.25 14Z"
      />
      <path
        fill="currentColor"
        d="M7.25 7.689V2a.75.75 0 0 1 1.5 0v5.689l1.97-1.969a.749.749 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 6.78a.749.749 0 1 1 1.06-1.06l1.97 1.969Z"
      />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg className="octicon" viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path
        fill="currentColor"
        d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.921-.921l.93-3.25c.081-.286.235-.547.445-.758l8.61-8.61Zm.176 4.823L9.75 4.81l-6.286 6.287a.25.25 0 0 0-.064.108l-.558 1.953 1.953-.558a.249.249 0 0 0 .108-.064l6.286-6.286Zm1.238-3.763a.25.25 0 0 0-.354 0L10.94 3.65l1.41 1.41 1.134-1.133a.25.25 0 0 0 0-.354l-1.057-1.057Z"
      />
    </svg>
  );
}

function EyeIcon() {
  return (
    <svg className="octicon" viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path
        fill="currentColor"
        d="M8 2c1.981 0 3.671.992 4.933 2.078 1.27 1.091 2.187 2.345 2.637 3.023a1.62 1.62 0 0 1 0 1.798c-.45.678-1.367 1.932-2.637 3.023C11.67 13.008 9.981 14 8 14c-1.981 0-3.671-.992-4.933-2.078C1.797 10.83.88 9.576.43 8.898a1.62 1.62 0 0 1 0-1.798c.45-.677 1.367-1.931 2.637-3.022C4.33 2.992 6.019 2 8 2ZM1.679 7.932a.12.12 0 0 0 0 .136c.411.622 1.241 1.75 2.366 2.717C5.176 11.758 6.527 12.5 8 12.5c1.473 0 2.825-.742 3.955-1.715 1.124-.967 1.954-2.096 2.366-2.717a.12.12 0 0 0 0-.136c-.412-.621-1.242-1.75-2.366-2.717C10.824 4.242 9.473 3.5 8 3.5c-1.473 0-2.825.742-3.955 1.715-1.124.967-1.954 2.096-2.366 2.717ZM8 10a2 2 0 1 1-.001-3.999A2 2 0 0 1 8 10Z"
      />
    </svg>
  );
}

function OutlineIcon() {
  return (
    <svg className="octicon" viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path
        fill="currentColor"
        d="M0 2.75A.75.75 0 0 1 .75 2h14.5a.75.75 0 0 1 0 1.5H.75A.75.75 0 0 1 0 2.75ZM0 7.75A.75.75 0 0 1 .75 7h14.5a.75.75 0 0 1 0 1.5H.75A.75.75 0 0 1 0 7.75ZM.75 12a.75.75 0 0 0 0 1.5h14.5a.75.75 0 0 0 0-1.5H.75Z"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg className="octicon" viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path
        fill="currentColor"
        d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"
      />
    </svg>
  );
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function fileBasename(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path || "file";
}

function lineStats(content: string): { lines: number; loc: number } {
  if (!content) return { lines: 0, loc: 0 };
  const lines = content.split(/\r\n|\r|\n/).length;
  const loc = content
    .split(/\r\n|\r|\n/)
    .filter((l) => l.trim().length > 0).length;
  return { lines, loc };
}

function markdownOutline(content: string): Array<{ level: number; text: string; id: string }> {
  const out: Array<{ level: number; text: string; id: string }> = [];
  for (const line of content.split(/\r\n|\r|\n/)) {
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const level = m[1]!.length;
    const text = m[2]!.replace(/#+\s*$/, "").trim();
    if (!text) continue;
    const id = text
      .toLowerCase()
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-");
    out.push({ level, text, id });
  }
  return out;
}

function downloadTextFile(content: string, filename: string, mediaType: string): void {
  const blob = new Blob([content], {
    type: mediaType || "application/octet-stream",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 2_000);
}

/** Code-tab README / community file: formatted preview + pencil/eye. */
export function ReadmePanel({
  path,
  content,
  blobHref,
  className = "",
  /** Single label when not using headerTabs (e.g. path or "MIT license"). */
  title,
  /** Community tabs inside the panel header (replaces title/path). */
  headerTabs,
  /**
   * Owner of a registered repo → pencil → edit mode.
   * Otherwise → eye → blob view (no ?edit=1).
   */
  canEdit = false,
  /** Tip browse context — resolve relative README images from this tip. */
  prefix,
  label,
  branch,
  ownerOpts,
}: {
  path: string;
  content: string;
  blobHref: string;
  className?: string;
  title?: string;
  headerTabs?: ReactNode;
  canEdit?: boolean;
  prefix?: string;
  label?: string;
  branch?: string;
  ownerOpts?: RepoHrefOpts;
}) {
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // Always pencil → blob?edit=1
  // NEW CODE - TESTING: eye → view; pencil → edit when canEdit
  const actionHref = canEdit
    ? blobHref.includes("?")
      ? `${blobHref}&edit=1`
      : `${blobHref}?edit=1`
    : blobHref;

  const mdProps = useMemo(() => {
    if (!prefix || !label || !branch) return GFM_MARKDOWN_PROPS;
    return createGfmMarkdownProps({
      markdownPath: path,
      imageCacheScope: `${prefix}:${branch}`,
      repoImageHref: (repoPath) =>
        repoBlobHref(prefix, label, branch, repoPath, ownerOpts),
      loadRepoBlob: async (repoPath) => {
        try {
          const res = await api.blob(prefix, label, branch, repoPath);
          if (!res.contentBase64) {
            console.warn(
              "[freenet-hub] README image blob has no contentBase64:",
              repoPath,
              {
                size: res.size,
                tooLarge: res.tooLarge,
                mediaType: res.mediaType,
                binary: res.binary,
              },
            );
            return null;
          }
          return {
            mediaType: res.mediaType || "application/octet-stream",
            contentBase64: res.contentBase64,
          };
        } catch (err) {
          console.warn(
            "[freenet-hub] README image api.blob failed:",
            repoPath,
            err instanceof Error ? err.message : err,
          );
          return null;
        }
      },
    });
  }, [prefix, label, branch, path, ownerOpts]);

  return (
    <article className={`md-panel ${className}`.trim()}>
      <header className="md-panel-header">
        {headerTabs ? (
          <div className="md-panel-header-tabs">{headerTabs}</div>
        ) : (
          <span className="md-panel-title mono">{title ?? path}</span>
        )}
        <div className="md-panel-right">
          <Link
            to={actionHref}
            className="gh-readme-edit-btn"
            title={canEdit ? "Edit this file" : "View this file"}
            aria-label={canEdit ? `Edit ${path}` : `View ${path}`}
          >
            {canEdit ? <PencilIcon /> : <EyeIcon />}
          </Link>
        </div>
      </header>
      <div className="md-preview">
        <ReactMarkdown {...mdProps}>{content}</ReactMarkdown>
      </div>
    </article>
  );
}

interface FileContentPanelProps {
  path: string;
  content: string;
  prefix: string;
  label: string;
  /** Signed RepoState.name for edit bar (falls back to label). */
  displayName?: string;
  branch: string;
  meta?: string;
  className?: string;
  /** Show Preview tab when markdown. */
  allowPreview?: boolean;
  defaultMode?: FileViewMode;
  mediaType?: string;
  /** Repo owner — enables Edit. */
  isOwner?: boolean;
  /** GitHub-style `/raw/{branch}/{path}` (avoid sandbox blob: URLs). */
  rawHref?: string | null;
  /** Open in edit mode (e.g. README pencil → ?edit=1). */
  initialEditing?: boolean;
  ownerOpts?: RepoHrefOpts;
}

export function FileContentPanel({
  path,
  content,
  prefix,
  label,
  displayName,
  branch,
  meta,
  className = "",
  allowPreview = false,
  defaultMode,
  mediaType = "text/plain;charset=utf-8",
  isOwner = false,
  rawHref = null,
  initialEditing = false,
  ownerOpts,
}: FileContentPanelProps) {
  const initial: FileViewMode =
    defaultMode ?? (allowPreview ? "preview" : "code");
  const [mode, setMode] = useState<FileViewMode>(initial);
  const [blameLines, setBlameLines] = useState<BlameLine[] | null>(null);
  const [blameNote, setBlameNote] = useState<string | null>(null);
  const [blameError, setBlameError] = useState<string | null>(null);
  const [blameBusy, setBlameBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [editing, setEditing] = useState(Boolean(initialEditing && isOwner));
  const [showCantEdit, setShowCantEdit] = useState(
    Boolean(initialEditing && !isOwner),
  );
  const [editMode, setEditMode] = useState<"edit" | "preview">("edit");
  const [draft, setDraft] = useState(content);
  const [subject, setSubject] = useState(`Update ${fileBasename(path)}`);
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [commitModalOpen, setCommitModalOpen] = useState(false);
  const navigate = useNavigate();
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const blobHref = useHref(repoHref(...)); // used with location.assign → 404
  const blobPath = repoHref(
    prefix,
    label,
    `blob/${encodeURIComponent(branch)}/${path.split("/").map(encodeURIComponent).join("/")}`,
  );

  const mdProps = useMemo(
    () =>
      createGfmMarkdownProps({
        markdownPath: path,
        imageCacheScope: `${prefix}:${branch}`,
        repoImageHref: (repoPath) =>
          repoBlobHref(prefix, label, branch, repoPath, ownerOpts),
        loadRepoBlob: async (repoPath) => {
          try {
            const res = await api.blob(prefix, label, branch, repoPath);
            if (!res.contentBase64) {
              console.warn(
                "[freenet-hub] markdown image blob has no contentBase64:",
                repoPath,
                {
                  size: res.size,
                  tooLarge: res.tooLarge,
                  mediaType: res.mediaType,
                },
              );
              return null;
            }
            return {
              mediaType: res.mediaType || "application/octet-stream",
              contentBase64: res.contentBase64,
            };
          } catch (err) {
            console.warn(
              "[freenet-hub] markdown image api.blob failed:",
              repoPath,
              err instanceof Error ? err.message : err,
            );
            return null;
          }
        },
      }),
    [prefix, label, branch, path, ownerOpts],
  );

  const stats = useMemo(() => lineStats(content), [content]);
  const outline = useMemo(
    () => (allowPreview ? markdownOutline(content) : []),
    [allowPreview, content],
  );
  const statsLabel =
    meta ??
    `${stats.lines} lines (${stats.loc} loc)`;

  useEffect(() => {
    setMode(allowPreview ? "preview" : "code");
    setBlameLines(null);
    setBlameNote(null);
    setBlameError(null);
    setBlameBusy(false);
    setEditing(Boolean(initialEditing && isOwner));
    setShowCantEdit(Boolean(initialEditing && !isOwner));
    setDraft(content);
    setSubject(`Update ${fileBasename(path)}`);
    setDescription("");
    setEditError(null);
    setOutlineOpen(false);
    setCommitModalOpen(false);
  }, [path, allowPreview, content, initialEditing, isOwner]);

  useEffect(() => {
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // if (mode !== "blame" || blameLines != null || blameBusy) return;
    // …blameBusy in deps cancelled the in-flight request and left busy stuck true

    // NEW CODE - TESTING
    if (mode !== "blame") return;
    let cancelled = false;
    setBlameBusy(true);
    setBlameError(null);
    setBlameLines(null);
    setBlameNote(null);
    void api
      .blame(prefix, label, branch, path)
      .then((res) => {
        if (cancelled) return;
        setBlameLines(res.lines);
        setBlameNote(res.note ?? null);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setBlameError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        setBlameBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [mode, prefix, label, branch, path]);

  const onCopy = () => {
    void copyText(content).then((ok) => {
      if (!ok) return;
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    });
  };

  const onDownload = () => {
    downloadTextFile(content, fileBasename(path), mediaType);
  };

  const onStartEdit = () => {
    // NEW CODE - TESTING: non-owners get fork placeholder (forks not shipped)
    if (!isOwner) {
      setShowCantEdit(true);
      setEditing(false);
      return;
    }
    setDraft(content);
    setEditMode("edit");
    setEditing(true);
    setShowCantEdit(false);
    setEditError(null);
  };

  const onCancelEdit = () => {
    setEditing(false);
    setShowCantEdit(false);
    setCommitModalOpen(false);
    setDraft(content);
    setEditError(null);
    setBusy(false);
  };

  const openCommitModal = () => {
    if (!isOwner || busy) return;
    setEditError(null);
    setCommitModalOpen(true);
  };

  const onCommitEdit = () => {
    if (!isOwner || busy) return;
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // window.confirm(…) before push
    // NEW CODE - TESTING: GitHub-style commit modal (no browser confirm)
    setBusy(true);
    setEditError(null);
    void (async () => {
      try {
        await pushFilesToFreenet({
          prefix,
          branch,
          files: [{ path, content: draft }],
          subject: subject.trim() || `Update ${fileBasename(path)}`,
          description: description.trim() || undefined,
        });
        // OLD CODE - KEEP UNTIL CONFIRMED WORKING
        // window.location.reload();
        // window.location.assign(blobHref); // Freenet deep-path hard-nav → 404 wait
        // NEW CODE - TESTING: leave edit mode + SPA nav; tip event refetches blob
        setEditing(false);
        setCommitModalOpen(false);
        setDraft(draft);
        navigate(blobPath, { replace: true });
        setBusy(false);
      } catch (err) {
        setEditError(err instanceof Error ? err.message : String(err));
        setBusy(false);
      }
    })();
  };

  if (showCantEdit) {
    return (
      <article className={`md-panel gh-file-cant-edit ${className}`.trim()}>
        {/* OLD CODE - KEEP UNTIL CONFIRMED WORKING
        <CantEditRepoPanel />
        */}
        {/* NEW CODE - TESTING: Repository button back to code tab */}
        <CantEditRepoPanel backHref={repoHref(prefix, label, "")} />
      </article>
    );
  }

  if (editing) {
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // Full create-file chrome (path bar + nested card) felt like a page/iframe
    // inside the blob view. Kept for easy rollback.
    // return (
    //   <article className={`md-panel gh-file-edit ${className}`.trim()}>
    //     <div className="gh-file-create-bar">…</div>
    //     <div className="gh-file-create-editor-card">…</div>
    //     <div className="gh-commit-box">…</div>
    //   </article>
    // );

    // NEW CODE - TESTING: Cancel/Commit stay above; Edit|Preview live in CM chrome
    return (
      <article className={`md-panel gh-file-edit gh-file-edit-inplace ${className}`.trim()}>
        <header className="md-panel-header gh-file-toolbar">
          <div className="gh-file-toolbar-left">
            <span className="muted tiny gh-file-stats">
              Editing {displayName?.trim() || label}/{path} on {branch}
            </span>
          </div>
          <div className="gh-file-toolbar-actions" role="group" aria-label="Edit actions">
            <button
              type="button"
              className="gh-file-action-btn"
              onClick={onCancelEdit}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn"
              onClick={openCommitModal}
              disabled={busy}
            >
              {busy ? "Publishing…" : "Commit changes…"}
            </button>
          </div>
        </header>

        {/* OLD CODE - KEEP UNTIL CONFIRMED WORKING
        Edit|Preview lived in md-panel-header; body was a plain <textarea>.
        */}
        {/* NEW CODE - TESTING: CodeMirror 6 + GitHub theme */}
        <FileCodeEditor
          value={draft}
          onChange={setDraft}
          disabled={busy}
          aria-label="File contents"
          path={path}
          viewMode={editMode}
          headerStart={
            <div className="gh-code-editor-tabs" role="group" aria-label="Edit view mode">
              <button
                type="button"
                className={`gh-code-editor-tab${editMode === "edit" ? " active" : ""}`}
                onClick={() => setEditMode("edit")}
              >
                Edit
              </button>
              {allowPreview && isMarkdownPath(path) ? (
                <button
                  type="button"
                  className={`gh-code-editor-tab${editMode === "preview" ? " active" : ""}`}
                  onClick={() => setEditMode("preview")}
                >
                  Preview
                </button>
              ) : null}
            </div>
          }
          preview={
            <div className="md-preview">
              <ReactMarkdown {...mdProps}>{draft}</ReactMarkdown>
            </div>
          }
        />

        {/* OLD CODE - KEEP UNTIL CONFIRMED WORKING: inline .gh-commit-box at bottom of edit page */}
        {/* NEW CODE - TESTING: GitHub-style commit popup */}
        {commitModalOpen ? (
          <div
            className="gh-commit-modal-backdrop"
            role="presentation"
            onClick={() => {
              if (!busy) setCommitModalOpen(false);
            }}
          >
            <div
              className="gh-commit-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="gh-commit-modal-title"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="gh-commit-modal-head">
                <h2 id="gh-commit-modal-title">Commit changes</h2>
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
                {editError ? (
                  <div className="error-banner">{editError}</div>
                ) : null}
                <label className="gh-commit-modal-field">
                  <span className="gh-commit-modal-label">Commit message</span>
                  <input
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    placeholder={`Update ${fileBasename(path)}`}
                    aria-label="Commit message"
                    disabled={busy}
                    autoFocus
                  />
                </label>
                <label className="gh-commit-modal-field">
                  <span className="gh-commit-modal-label">
                    Extended description
                  </span>
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Add an optional extended description..."
                    rows={5}
                    aria-label="Extended description"
                    disabled={busy}
                  />
                </label>
                <p className="muted tiny gh-commit-modal-hint">
                  Browser tip push currently publishes a pack built from this
                  file alone. Use <span className="mono">freenet-git</span> for
                  normal multi-file edits.
                </p>
              </div>
              <div className="gh-commit-modal-actions">
                <button
                  type="button"
                  className="btn secondary"
                  onClick={() => setCommitModalOpen(false)}
                  disabled={busy}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={onCommitEdit}
                  disabled={busy}
                >
                  {busy ? "Publishing…" : "Commit changes"}
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </article>
    );
  }

  return (
    <article className={`md-panel ${className}`.trim()}>
      <header className="md-panel-header gh-file-toolbar">
        <div className="gh-file-toolbar-left">
          <div className="view-toggle" role="group" aria-label="File view mode">
            {allowPreview ? (
              <button
                type="button"
                className={mode === "preview" ? "active" : ""}
                onClick={() => setMode("preview")}
              >
                Preview
              </button>
            ) : null}
            <button
              type="button"
              className={mode === "code" ? "active" : ""}
              onClick={() => setMode("code")}
            >
              Code
            </button>
            <button
              type="button"
              className={mode === "blame" ? "active" : ""}
              onClick={() => setMode("blame")}
            >
              Blame
            </button>
          </div>
          <span className="muted tiny gh-file-stats">{statsLabel}</span>
        </div>
        <div className="gh-file-toolbar-actions" role="group" aria-label="File actions">
          {rawHref ? (
            // OLD CODE - KEEP UNTIL CONFIRMED WORKING
            // freenetNodeRawFileHref — non-stock freenet only
            // NEW CODE - TESTING: GitAtlas website /?raw=…
            <a
              className="gh-file-action-btn"
              href={freenetRawFileHref(rawHref)}
              target="_blank"
              rel="noreferrer"
            >
              Raw
            </a>
          ) : null}
          <button
            type="button"
            className="gh-file-action-btn icon"
            onClick={onCopy}
            title={copied ? "Copied!" : "Copy file contents"}
            aria-label={copied ? "Copied" : "Copy file contents"}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </button>
          <button
            type="button"
            className="gh-file-action-btn icon"
            onClick={onDownload}
            title="Download file"
            aria-label="Download file"
          >
            <DownloadIcon />
          </button>
          {/* OLD CODE - KEEP UNTIL CONFIRMED WORKING
          {isOwner ? (
            <button … pencil … />
          ) : null}
          */}
          {/* NEW CODE - TESTING: pencil for everyone; non-owners → cant-edit panel */}
          <button
            type="button"
            className="gh-file-action-btn icon"
            onClick={onStartEdit}
            title="Edit this file"
            aria-label="Edit this file"
          >
            <PencilIcon />
          </button>
          {allowPreview && outline.length > 0 ? (
            <button
              type="button"
              className={`gh-file-action-btn icon${outlineOpen ? " active" : ""}`}
              onClick={() => setOutlineOpen((v) => !v)}
              title="Outline"
              aria-label="Outline"
              aria-expanded={outlineOpen}
            >
              <OutlineIcon />
            </button>
          ) : null}
        </div>
      </header>

      {outlineOpen && outline.length > 0 ? (
        <nav className="gh-file-outline" aria-label="File outline">
          <ul>
            {outline.map((h) => (
              <li key={`${h.level}-${h.id}`} style={{ paddingLeft: (h.level - 1) * 12 }}>
                <button
                  type="button"
                  className="gh-file-outline-link"
                  onClick={() => {
                    const el = document.getElementById(h.id);
                    el?.scrollIntoView({ behavior: "smooth", block: "start" });
                  }}
                >
                  {h.text}
                </button>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}

      {mode === "preview" && allowPreview ? (
        <div className="md-preview">
          <ReactMarkdown
            {...mdProps}
            components={{
              ...mdProps.components,
              h1: ({ children, ...props }) => (
                <h1 id={slugFromChildren(children)} {...props}>
                  {children}
                </h1>
              ),
              h2: ({ children, ...props }) => (
                <h2 id={slugFromChildren(children)} {...props}>
                  {children}
                </h2>
              ),
              h3: ({ children, ...props }) => (
                <h3 id={slugFromChildren(children)} {...props}>
                  {children}
                </h3>
              ),
              h4: ({ children, ...props }) => (
                <h4 id={slugFromChildren(children)} {...props}>
                  {children}
                </h4>
              ),
            }}
          >
            {content}
          </ReactMarkdown>
        </div>
      ) : null}
      {mode === "code" ? <pre className="md-code">{content}</pre> : null}
      {mode === "blame" ? (
        <BlameView
          lines={blameLines}
          note={blameNote}
          error={blameError}
          busy={blameBusy}
        />
      ) : null}
    </article>
  );
}

function slugFromChildren(children: ReactNode): string {
  const text = flattenText(children);
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

function flattenText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flattenText).join("");
  if (typeof node === "object" && "props" in node) {
    const props = (node as { props?: { children?: ReactNode } }).props;
    return flattenText(props?.children);
  }
  return "";
}

function BlameView({
  lines,
  note,
  error,
  busy,
}: {
  lines: BlameLine[] | null;
  note: string | null;
  error: string | null;
  busy: boolean;
}): ReactNode {
  if (busy) {
    return (
      <PageLoadingOverlay
        skeleton="blame"
        message="Loading blame from tip packs…"
      />
    );
  }
  if (error) {
    return (
      <div className="error-banner" style={{ whiteSpace: "pre-wrap" }}>
        {error}
      </div>
    );
  }
  if (!lines) return null;

  return (
    <div className="blame-view">
      {note ? <p className="muted tiny blame-note">{note}</p> : null}
      <table className="blame-table">
        <tbody>
          {lines.map((row) => (
            <tr key={row.line}>
              <td className="blame-meta" title={row.summary}>
                <span className="mono blame-hash">{row.short}</span>
                <span className="blame-author">{row.author}</span>
              </td>
              <td className="blame-lineno muted">{row.line}</td>
              <td className="blame-code">
                <code>{row.content}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

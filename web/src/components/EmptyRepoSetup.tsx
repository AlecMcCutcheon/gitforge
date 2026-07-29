/**
 * GitHub-style empty repo: Quick setup + create/upload entry points.
 * Browser push is not available yet — CLI scripts publish the first tip pack.
 */
import { useCallback, useMemo, useState } from "react";
import { Link } from "../spa-link";
import { repoHref, type RepoHrefOpts } from "../lib/repo-path";
import type { StarterKind } from "../lib/starter-files";

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function CopyIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden
    >
      <path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z" />
      <path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z" />
    </svg>
  );
}

function CodeBlock({
  code,
  label,
}: {
  code: string;
  label: string;
}) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(() => {
    void copyText(code).then((ok) => {
      if (!ok) return;
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    });
  }, [code]);
  return (
    <div className="gh-setup-code-wrap">
      <button
        type="button"
        className="gh-setup-copy"
        onClick={onCopy}
        aria-label={copied ? "Copied" : `Copy ${label}`}
        title={copied ? "Copied!" : "Copy"}
      >
        <CopyIcon />
      </button>
      <pre className="gh-setup-code">{code}</pre>
    </div>
  );
}

export function EmptyRepoSetup({
  prefix,
  label,
  displayName,
  remote,
  defaultBranch,
  isOwner,
  ownerOpts,
}: {
  prefix: string;
  label: string;
  /** Signed RepoState.name when known. */
  displayName?: string;
  remote: string;
  defaultBranch: string;
  isOwner: boolean;
  ownerOpts?: RepoHrefOpts;
}) {
  const branch = defaultBranch || "main";
  const shownName = displayName?.trim() || label;
  const base = repoHref(prefix, label, "", ownerOpts);
  const newFileHref = `${base}/new/${encodeURIComponent(branch)}`;
  const uploadHref = `${base}/upload/${encodeURIComponent(branch)}`;

  const starterHref = (kind: StarterKind) =>
    `${newFileHref}?filename=${encodeURIComponent(
      kind === "readme"
        ? "README.md"
        : kind === "license"
          ? "LICENSE"
          : ".gitignore",
    )}`;

  const createNewScript = useMemo(
    () =>
      `echo "# ${shownName}" >> README.md
git init
git add README.md
git commit -m "first commit"
git branch -M ${branch}
git remote add origin ${remote}
git push -u origin ${branch}`,
    [branch, shownName, remote],
  );

  const pushExistingScript = useMemo(
    () =>
      `git remote add origin ${remote}
git branch -M ${branch}
git push -u origin ${branch}`,
    [branch, remote],
  );

  const [remoteCopied, setRemoteCopied] = useState(false);

  return (
    <div className="gh-empty-setup">
      <section className="gh-setup-card">
        <h2 className="gh-setup-heading">
          Quick setup — if you’ve done this kind of thing before
        </h2>

        <div className="gh-setup-remote-row">
          <span className="gh-setup-proto">freenet</span>
          <input
            className="gh-setup-remote-input mono"
            readOnly
            value={remote}
            aria-label="Freenet remote URL"
            onFocus={(e) => e.currentTarget.select()}
          />
          <button
            type="button"
            className="gh-setup-copy gh-setup-copy-inline"
            aria-label={remoteCopied ? "Copied" : "Copy remote URL"}
            title={remoteCopied ? "Copied!" : "Copy"}
            onClick={() => {
              void copyText(remote).then((ok) => {
                if (!ok) return;
                setRemoteCopied(true);
                window.setTimeout(() => setRemoteCopied(false), 1600);
              });
            }}
          >
            <CopyIcon />
          </button>
        </div>

        <p className="gh-setup-get-started">
          Get started by{" "}
          {/* OLD CODE - KEEP UNTIL CONFIRMED WORKING
          Always linked create/upload (non-owners hit the editor then failed on commit).
          <Link to={newFileHref}>creating a new file</Link> or{" "}
          <Link to={uploadHref}>uploading an existing file</Link>.
          */}
          {/* NEW CODE - TESTING: only owners get editor links */}
          {isOwner ? (
            <>
              <Link to={newFileHref}>creating a new file</Link> or{" "}
              <Link to={uploadHref}>uploading an existing file</Link>
            </>
          ) : (
            <>
              <span className="muted">creating a new file</span> or{" "}
              <span className="muted">uploading an existing file</span>
            </>
          )}
          . We recommend every repository include a{" "}
          {isOwner ? (
            <>
              <Link to={starterHref("readme")}>README</Link>,{" "}
              <Link to={starterHref("license")}>LICENSE</Link>, and{" "}
              <Link to={starterHref("gitignore")}>.gitignore</Link>
            </>
          ) : (
            <>
              <span className="muted">README</span>,{" "}
              <span className="muted">LICENSE</span>, and{" "}
              <span className="muted">.gitignore</span>
            </>
          )}
          .
        </p>
        {!isOwner ? (
          <p className="muted tiny">
            Sign in with the repo owner identity to create or upload files from
            the browser.
          </p>
        ) : (
          <p className="muted tiny">
            Create or upload files here to publish the first Freenet tip pack
            (same contract path as{" "}
            <span className="mono">git push</span>).
          </p>
        )}
      </section>

      <section className="gh-setup-card">
        <h3 className="gh-setup-subheading">
          …or create a new repository on the command line
        </h3>
        <CodeBlock code={createNewScript} label="create script" />
      </section>

      <section className="gh-setup-card">
        <h3 className="gh-setup-subheading">
          …or push an existing repository from the command line
        </h3>
        <CodeBlock code={pushExistingScript} label="push script" />
      </section>

      <p className="gh-setup-tip muted tiny">
        <strong>ProTip!</strong> Use this Freenet remote with{" "}
        <span className="mono">git-remote-freenet</span> and the same owner key
        that created the contract.
      </p>
    </div>
  );
}

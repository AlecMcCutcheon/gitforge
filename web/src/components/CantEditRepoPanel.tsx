/**
 * GitHub-style “can’t edit” surface. Fork isn’t available yet — placeholder copy.
 */
// OLD CODE - KEEP UNTIL CONFIRMED WORKING
// import { Link } from "../spa-link";

function GitBranchIcon() {
  return (
    <svg
      className="octicon"
      viewBox="0 0 16 16"
      width="48"
      height="48"
      aria-hidden
    >
      <path
        fill="currentColor"
        d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H8.75v2.128a2.251 2.251 0 1 1-1.5 0V8.5H6A2.5 2.5 0 0 1 3.5 6V5.372a2.25 2.25 0 1 1 1.5 0V6a1 1 0 0 0 1 1h4.5a1 1 0 0 0 1-1V5.372A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"
      />
    </svg>
  );
}

export function CantEditRepoPanel({
  backHref: _backHref,
}: {
  /** @deprecated Back link removed — callers may still pass backHref. */
  backHref?: string;
}) {
  void _backHref;
  return (
    <section className="gh-cant-edit" aria-labelledby="gh-cant-edit-title">
      <div className="gh-cant-edit-icon" aria-hidden>
        <GitBranchIcon />
      </div>
      <h2 id="gh-cant-edit-title" className="gh-cant-edit-title">
        You can’t edit this repository yet
      </h2>
      <p className="gh-cant-edit-body">
        Sorry, you’re not able to edit this repository directly. Forking isn’t
        available in GitForge yet — only the repository owner can change files
        from the browser for now.
      </p>
      <button type="button" className="btn gh-cant-edit-btn" disabled>
        Fork this repository
      </button>
      <p className="muted tiny gh-cant-edit-note">
        Fork placeholder — coming later.
      </p>
      {/* OLD CODE - KEEP UNTIL CONFIRMED WORKING
      {backHref ? (
        <p className="gh-cant-edit-back">
          <Link to={backHref} className="btn secondary">
            Back to repository
          </Link>
        </p>
      ) : null}
      {backHref ? (
        <p className="gh-cant-edit-back">
          <Link to={backHref} className="btn secondary">
            Repository
          </Link>
        </p>
      ) : null}
      */}
    </section>
  );
}

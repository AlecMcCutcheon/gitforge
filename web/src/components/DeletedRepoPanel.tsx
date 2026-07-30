/**
 * Main content when a Freenet repo has been soft-deleted (tombstone).
 * Replaces the file explorer / empty-repo setup so the page does not go blank.
 */
import { Link } from "../spa-link";

interface DeletedRepoPanelProps {
  displayName: string;
  deletedAt?: string | null;
}

export function DeletedRepoPanel({
  displayName,
  deletedAt,
}: DeletedRepoPanelProps) {
  return (
    <section className="gh-deleted-repo" role="status">
      <div className="gh-deleted-repo-icon" aria-hidden>
        <svg
          className="octicon"
          viewBox="0 0 24 24"
          width="48"
          height="48"
          fill="currentColor"
        >
          <path d="M16 1.75V3h5.25a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1 0-1.5H8V1.75C8 .784 8.784 0 9.75 0h4.5C15.216 0 16 .784 16 1.75Zm-6.5 0V3h5V1.75a.25.25 0 0 0-.25-.25h-4.5a.25.25 0 0 0-.25.25ZM4.997 6.178a.75.75 0 1 0-1.493.144L4.916 20.92a1.75 1.75 0 0 0 1.742 1.58h10.684a1.75 1.75 0 0 0 1.742-1.581l1.412-14.597a.75.75 0 0 0-1.494-.144l-1.412 14.596a.25.25 0 0 1-.249.226H6.658a.25.25 0 0 1-.249-.226L4.997 6.178Z" />
          <path d="M9.206 7.501a.75.75 0 0 1 .67.917l-.95 4.751a.75.75 0 0 1-1.467-.293l.95-4.751a.75.75 0 0 1 .797-.624Zm6.255.917a.75.75 0 1 0-1.467-.293l-.95 4.751a.75.75 0 0 0 1.467.293l.95-4.751Z" />
        </svg>
      </div>
      <h2 className="gh-deleted-repo-title">This repository has been deleted</h2>
      <p className="gh-deleted-repo-body muted">
        <strong>{displayName}</strong> was marked deleted by the owner
        {deletedAt ? (
          <>
            {" "}
            on <span className="mono">{deletedAt}</span>
          </>
        ) : null}
        . It no longer appears in GitForge Discover. Pack history may still
        exist on Freenet until caches forget it.
      </p>
      <div className="gh-deleted-repo-actions">
        <Link to="/" className="btn">
          Back to Discover
        </Link>
      </div>
    </section>
  );
}

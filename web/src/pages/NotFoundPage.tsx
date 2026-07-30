import { Link } from "../spa-link";
import type { ReactElement } from "react";
import { brand } from "../lib/brand";
import { useDocumentTitle } from "../lib/document-title";

export type NotFoundKind = "page" | "repo" | "person";

interface NotFoundPageProps {
  kind?: NotFoundKind;
  /** Optional path or id shown under the title. */
  detail?: string;
}

const COPY: Record<
  NotFoundKind,
  { code: string; title: string; body: string }
> = {
  page: {
    code: "404",
    title: "Page not found",
    body: `That address is not a page in ${brand.displayName}.`,
  },
  repo: {
    code: "404",
    title: "Repository not found",
    body: "No Freenet repo answered at this path. It may be unpublished, mistyped, or still propagating.",
  },
  person: {
    code: "404",
    title: "Person not found",
    body: "No profile matched this fingerprint or word name.",
  },
};

/** Shared 404 for unknown routes, missing repos, and missing people. */
export function NotFoundPage({
  kind = "page",
  detail,
}: NotFoundPageProps): ReactElement {
  const copy = COPY[kind];
  useDocumentTitle(copy.title);
  return (
    <main className="page not-found-page">
      <p className="not-found-code">{copy.code}</p>
      <h1>{copy.title}</h1>
      <p className="lede">{copy.body}</p>
      {detail ? <p className="mono muted tiny break">{detail}</p> : null}
      <p className="row">
        <Link to="/" className="btn">
          Back to {brand.displayName}
        </Link>
      </p>
    </main>
  );
}

/** Nested access block (no outer <main>) for owner-only routes inside a repo page. */
export function AccessDeniedPanel({
  title = "Not allowed",
  body = "Sign in as the repository owner to use this page.",
  backHref,
  backLabel = "Back to repository",
}: {
  title?: string;
  body?: string;
  backHref: string;
  backLabel?: string;
}): ReactElement {
  return (
    <section className="not-found-page" aria-labelledby="access-denied-title">
      <p className="not-found-code">403</p>
      <h1 id="access-denied-title">{title}</h1>
      <p className="lede">{body}</p>
      <p className="row">
        <Link to={backHref} className="btn">
          {backLabel}
        </Link>
        <Link to="/account" className="btn secondary">
          Sign in
        </Link>
      </p>
    </section>
  );
}

/** Heuristic: Freenet/repo load failed because nothing is there. */
export function looksLikeRepoNotFound(message: string): boolean {
  const m = message.toLowerCase();
  return (
    /\b404\b/.test(m) ||
    /not found/.test(m) ||
    /empty state/.test(m) ||
    /no such/.test(m) ||
    /unknown repo/.test(m) ||
    /missing repo/.test(m) ||
    /contract not found/.test(m)
  );
}

/** Heuristic: person resolve / profile fetch failed as missing. */
export function looksLikePersonNotFound(message: string): boolean {
  const m = message.toLowerCase();
  return (
    /\b404\b/.test(m) ||
    /not found/.test(m) ||
    /unknown (person|user|fingerprint)/.test(m) ||
    /no profile/.test(m) ||
    /could not resolve/.test(m)
  );
}

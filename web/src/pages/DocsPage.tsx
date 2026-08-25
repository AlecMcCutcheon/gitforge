/**
 * GitForge Docs — `/docs` and `/docs/:slug`.
 *
 * Left-hand section nav (grouped), a sticky header, and prev/next pager.
 * Content lives in ./docs-content so it can grow without bloating this file.
 */
import { useParams } from "react-router-dom";
import { NavLink } from "../spa-link";
import { useDocumentTitle } from "../lib/document-title";
import { NotFoundPage } from "./NotFoundPage";
import {
  DOCS_GROUPS,
  DOCS_SECTIONS,
  docsSectionBySlug,
  type DocsSection,
} from "./docs-content";

/** First section is the docs root (`/docs` → overview). */
function sectionHref(s: DocsSection): string {
  return s.slug === DOCS_SECTIONS[0].slug ? "/docs" : `/docs/${s.slug}`;
}

function BookIcon() {
  return (
    <svg className="octicon" viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path
        fill="currentColor"
        d="M0 1.75A.75.75 0 0 1 .75 1h4.253c1.227 0 2.317.59 3 1.501A3.743 3.743 0 0 1 11.006 1h4.245a.75.75 0 0 1 .75.75v10.5a.75.75 0 0 1-.75.75h-4.507a2.25 2.25 0 0 0-1.591.659l-.622.621a.75.75 0 0 1-1.06 0l-.622-.621A2.25 2.25 0 0 0 5.258 13H.75a.75.75 0 0 1-.75-.75Zm7.251 10.324.004-5.073-.002-2.253A2.25 2.25 0 0 0 5.003 2.5H1.5v9h3.757a3.75 3.75 0 0 1 1.994.574ZM8.755 4.75l-.004 7.322a3.752 3.752 0 0 1 1.992-.572H14.5v-9h-3.495a2.25 2.25 0 0 0-2.25 2.25Z"
      />
    </svg>
  );
}

export function DocsPage() {
  const { slug } = useParams();
  const section = slug ? (docsSectionBySlug.get(slug) ?? null) : DOCS_SECTIONS[0];
  useDocumentTitle(section ? `Docs · ${section.title}` : "Docs");

  if (!section) {
    return <NotFoundPage kind="page" />;
  }

  const idx = DOCS_SECTIONS.indexOf(section);
  const prev = idx > 0 ? DOCS_SECTIONS[idx - 1] : null;
  const next = idx < DOCS_SECTIONS.length - 1 ? DOCS_SECTIONS[idx + 1] : null;

  return (
    <main className="docs-page">
      <div className="docs-layout">
        <aside className="docs-nav" aria-label="Docs navigation">
          <div className="docs-nav-heading">
            <span className="docs-nav-book" aria-hidden>
              <BookIcon />
            </span>
            GitForge docs
          </div>
          {DOCS_GROUPS.map((group) => (
            <div key={group} className="docs-nav-group">
              <div className="docs-nav-group-label">{group}</div>
              <nav className="docs-nav-items" aria-label={`${group} docs`}>
                {DOCS_SECTIONS.filter((s) => s.group === group).map((s) => (
                  <NavLink
                    key={s.slug}
                    to={sectionHref(s)}
                    end={s.slug === DOCS_SECTIONS[0].slug}
                    className={({ isActive }) =>
                      isActive ? "docs-nav-link active" : "docs-nav-link"
                    }
                  >
                    {s.nav}
                  </NavLink>
                ))}
              </nav>
            </div>
          ))}
        </aside>

        <article className="docs-main">
          <header className="docs-header">
            <h1>{section.title}</h1>
            {section.blurb ? <p className="muted">{section.blurb}</p> : null}
          </header>

          <div className="docs-body">{section.body}</div>

          <nav className="docs-pager" aria-label="Docs page navigation">
            {prev ? (
              <NavLink
                to={sectionHref(prev)}
                className="docs-pager-link docs-pager-link--prev"
              >
                <span className="docs-pager-kicker">Previous</span>
                <span className="docs-pager-title">{prev.nav}</span>
              </NavLink>
            ) : (
              <span />
            )}
            {next ? (
              <NavLink
                to={sectionHref(next)}
                className="docs-pager-link docs-pager-link--next"
              >
                <span className="docs-pager-kicker">Next</span>
                <span className="docs-pager-title">{next.nav}</span>
              </NavLink>
            ) : (
              <span />
            )}
          </nav>
        </article>
      </div>
    </main>
  );
}

import type { CSSProperties, ReactNode } from "react";

export type LoadingSkeleton =
  | "tree"
  | "blob"
  | "commits"
  | "branches"
  | "refs"
  | "blame"
  | "sidebar"
  | "readme"
  | "auth"
  | "people"
  | "cards"
  | "landing"
  | "discover";

function Bone({
  className,
  style,
}: {
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      className={["skel-bone", className].filter(Boolean).join(" ")}
      style={style}
      aria-hidden
    />
  );
}

function TreeSkeleton() {
  return (
    <div className="gh-file-box skel-layout" aria-hidden>
      <div className="gh-commit-strip skel-commit-strip">
        <div className="gh-commit-main">
          <Bone className="skel-bone--sm" style={{ width: "5.5rem" }} />
          <Bone className="skel-bone--md" style={{ width: "14rem" }} />
        </div>
        <div className="gh-commit-meta">
          <Bone className="skel-bone--sm" style={{ width: "4rem" }} />
          <Bone className="skel-bone--sm" style={{ width: "5rem" }} />
        </div>
      </div>
      <table className="file-table">
        <tbody>
          {Array.from({ length: 8 }, (_, i) => (
            <tr key={i}>
              <td className="gh-file-name-cell">
                <span className="gh-file-link skel-file-row">
                  <Bone className="skel-bone--icon" />
                  <Bone
                    className="skel-bone--md"
                    style={{ width: `${9 + ((i * 3) % 7)}rem` }}
                  />
                </span>
              </td>
              <td>
                <Bone className="skel-bone--sm" style={{ width: "11rem" }} />
              </td>
              <td>
                <Bone className="skel-bone--sm" style={{ width: "4.5rem" }} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BlobSkeleton() {
  return (
    <div className="skel-layout skel-blob" aria-hidden>
      <div className="skel-blob__toolbar">
        <Bone className="skel-bone--md" style={{ width: "10rem" }} />
        <Bone className="skel-bone--sm" style={{ width: "5rem" }} />
      </div>
      <div className="skel-blob__body">
        {Array.from({ length: 12 }, (_, i) => (
          <Bone
            key={i}
            className="skel-bone--line"
            style={{ width: `${55 + ((i * 17) % 40)}%` }}
          />
        ))}
      </div>
    </div>
  );
}

function CommitsSkeleton() {
  return (
    <ul className="commit-list skel-layout" aria-hidden>
      {Array.from({ length: 6 }, (_, i) => (
        <li key={i}>
          <Bone className="skel-bone--sm" style={{ width: "4.5rem" }} />
          <div className="skel-commit-body">
            <Bone className="skel-bone--md" style={{ width: `${12 + (i % 4) * 2}rem` }} />
            <Bone className="skel-bone--sm" style={{ width: "9rem" }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

function BranchesSkeleton() {
  return (
    <div className="skel-layout skel-branches" aria-hidden>
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className="skel-branch-row">
          <Bone className="skel-bone--md" style={{ width: `${7 + (i % 3) * 2}rem` }} />
          <Bone className="skel-bone--sm" style={{ width: "5rem" }} />
          <Bone className="skel-bone--sm" style={{ width: "8rem" }} />
        </div>
      ))}
    </div>
  );
}

function RefsSkeleton() {
  return (
    <div className="skel-layout skel-refs" aria-hidden>
      <Bone className="skel-bone--lg" style={{ width: "40%" }} />
      <Bone className="skel-bone--md" style={{ width: "70%" }} />
      <Bone className="skel-bone--md" style={{ width: "55%" }} />
      <div className="skel-refs__block">
        {Array.from({ length: 5 }, (_, i) => (
          <Bone
            key={i}
            className="skel-bone--line"
            style={{ width: `${60 + ((i * 11) % 30)}%` }}
          />
        ))}
      </div>
    </div>
  );
}

function BlameSkeleton() {
  return (
    <div className="skel-layout skel-blame" aria-hidden>
      {Array.from({ length: 10 }, (_, i) => (
        <div key={i} className="skel-blame-row">
          <Bone className="skel-bone--sm" style={{ width: "4rem" }} />
          <Bone className="skel-bone--sm" style={{ width: "6rem" }} />
          <Bone
            className="skel-bone--line"
            style={{ width: `${50 + ((i * 13) % 40)}%`, flex: 1 }}
          />
        </div>
      ))}
    </div>
  );
}

function SideBlockSkeleton({
  titleWidth,
  lines,
}: {
  titleWidth: string;
  lines: number;
}) {
  return (
    <section className="gh-side-block skel-side-block">
      <Bone className="skel-bone--md" style={{ width: titleWidth }} />
      <div className="skel-side-block__body">
        {Array.from({ length: lines }, (_, i) => (
          <Bone
            key={i}
            className="skel-bone--line"
            style={{ width: `${55 + ((i * 19) % 40)}%` }}
          />
        ))}
      </div>
    </section>
  );
}

function SidebarSkeleton() {
  return (
    <aside className="gh-sidebar skel-layout skel-sidebar" aria-hidden>
      <SideBlockSkeleton titleWidth="4rem" lines={5} />
      <SideBlockSkeleton titleWidth="5rem" lines={2} />
      <SideBlockSkeleton titleWidth="3.5rem" lines={3} />
      <SideBlockSkeleton titleWidth="6.5rem" lines={4} />
      <SideBlockSkeleton titleWidth="5rem" lines={4} />
    </aside>
  );
}

function ReadmeSkeleton() {
  return (
    <article className="md-panel readme gh-readme skel-layout skel-readme" aria-hidden>
      <header className="md-panel-header">
        <Bone className="skel-bone--sm" style={{ width: "5.5rem" }} />
        <Bone className="skel-bone--sm" style={{ width: "4.5rem" }} />
      </header>
      <div className="md-preview skel-readme__body">
        <Bone className="skel-bone--lg" style={{ width: "55%", marginBottom: "1rem" }} />
        {Array.from({ length: 8 }, (_, i) => (
          <Bone
            key={i}
            className="skel-bone--line"
            style={{ width: `${62 + ((i * 13) % 35)}%` }}
          />
        ))}
        <Bone
          className="skel-bone--line"
          style={{ width: "40%", marginTop: "1rem" }}
        />
        {Array.from({ length: 4 }, (_, i) => (
          <Bone
            key={`b-${i}`}
            className="skel-bone--line"
            style={{ width: `${50 + ((i * 17) % 40)}%` }}
          />
        ))}
      </div>
    </article>
  );
}

function AuthSkeleton() {
  // Mirrors signed-out hub: heading + centered lede + card of three actions
  // (Create / Restore / Unlock) — not a username/password form.
  return (
    <div className="skel-layout skel-auth" aria-hidden>
      <Bone
        className="skel-bone--lg skel-auth__heading"
        style={{ width: "14rem", height: "1.75rem" }}
      />
      <div className="skel-auth__lede-wrap">
        <Bone className="skel-bone--md" style={{ width: "16rem" }} />
        <Bone className="skel-bone--sm" style={{ width: "11rem" }} />
      </div>
      <div className="auth-card auth-actions skel-auth__card">
        <Bone className="skel-bone--btn" />
        <Bone className="skel-bone--btn skel-bone--btn-secondary" />
        <Bone className="skel-bone--btn skel-bone--btn-secondary" />
      </div>
    </div>
  );
}

function PeopleSkeleton() {
  return (
    <div className="skel-layout skel-people" aria-hidden>
      <Bone className="skel-bone--lg" style={{ width: "10rem", marginBottom: "0.75rem" }} />
      <Bone className="skel-bone--md" style={{ width: "70%", marginBottom: "1rem" }} />
      <div className="skel-people__tabs">
        <Bone className="skel-bone--sm" style={{ width: "6rem", height: "2rem" }} />
        <Bone className="skel-bone--sm" style={{ width: "4rem", height: "2rem" }} />
      </div>
      <CardsSkeleton count={3} />
    </div>
  );
}

function CardsSkeleton({ count = 4 }: { count?: number }) {
  return (
    <ul className="repo-cards skel-layout skel-cards" aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <li key={i}>
          <div className="repo-card skel-card">
            <Bone className="skel-bone--md" style={{ width: `${8 + (i % 3) * 2}rem` }} />
            <Bone className="skel-bone--line" style={{ width: `${55 + ((i * 17) % 30)}%` }} />
            <Bone className="skel-bone--sm" style={{ width: "12rem" }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Logged-out marketing home wireframe. */
function LandingSkeleton() {
  return (
    <div className="skel-layout skel-landing" aria-hidden>
      <section className="landing-hero skel-landing__hero">
        <div className="landing-hero__inner">
          <div className="skel-landing__kicker">
            <Bone className="skel-bone--avatar" style={{ width: 28, height: 28 }} />
            <Bone className="skel-bone--md" style={{ width: "5.5rem" }} />
          </div>
          <Bone className="skel-bone--sm skel-landing__badge" style={{ width: "11rem" }} />
          <Bone
            className="skel-bone--lg skel-landing__title"
            style={{ width: "min(100%, 28rem)", height: "2.6rem" }}
          />
          <Bone
            className="skel-bone--lg skel-landing__title"
            style={{ width: "min(100%, 22rem)", height: "2.6rem" }}
          />
          <div className="skel-landing__lede">
            <Bone className="skel-bone--line" style={{ width: "92%" }} />
            <Bone className="skel-bone--line" style={{ width: "86%" }} />
            <Bone className="skel-bone--line" style={{ width: "70%" }} />
          </div>
          <div className="landing-cta skel-landing__cta">
            <Bone className="skel-bone--input skel-landing__cta-input" />
            <Bone className="skel-bone--btn skel-landing__cta-btn" />
            <Bone className="skel-bone--btn skel-bone--btn-secondary skel-landing__cta-btn" />
          </div>
          <Bone className="skel-bone--sm" style={{ width: "16rem" }} />
        </div>
      </section>

      <section className="landing-features skel-landing__features">
        {Array.from({ length: 3 }, (_, i) => (
          <article key={i} className="landing-feature">
            <Bone className="skel-bone--md" style={{ width: "70%", marginBottom: "0.5rem" }} />
            <Bone className="skel-bone--line" style={{ width: "95%" }} />
            <Bone className="skel-bone--line" style={{ width: "88%" }} />
            <Bone className="skel-bone--line" style={{ width: "60%" }} />
          </article>
        ))}
      </section>

      <section className="landing-repos panel skel-landing__repos">
        <Bone className="skel-bone--lg" style={{ width: "10rem", marginBottom: "0.5rem" }} />
        <Bone className="skel-bone--md" style={{ width: "80%", marginBottom: "1rem" }} />
        <CardsSkeleton count={3} />
      </section>
    </div>
  );
}

/** Signed-in Discover / dashboard wireframe. */
function DiscoverSkeleton() {
  return (
    <div className="skel-layout skel-discover page" aria-hidden>
      <section className="hero-panel skel-discover__hero">
        <Bone className="skel-bone--lg" style={{ width: "9rem", height: "2rem" }} />
        <div className="skel-discover__hero-lede">
          <Bone className="skel-bone--line" style={{ width: "95%" }} />
          <Bone className="skel-bone--line" style={{ width: "72%" }} />
        </div>
        <div className="search-row skel-discover__search">
          <Bone className="skel-bone--input" style={{ flex: 1 }} />
          <Bone className="skel-bone--btn" style={{ width: "4.5rem", marginTop: 0 }} />
        </div>
      </section>

      <section className="panel">
        <Bone className="skel-bone--lg" style={{ width: "12rem", marginBottom: "0.4rem" }} />
        <Bone className="skel-bone--sm" style={{ width: "18rem", marginBottom: "1rem" }} />
        <CardsSkeleton count={3} />
      </section>

      <section className="panel">
        <Bone className="skel-bone--lg" style={{ width: "10rem", marginBottom: "0.4rem" }} />
        <Bone className="skel-bone--sm" style={{ width: "22rem", marginBottom: "1rem" }} />
        <CardsSkeleton count={3} />
      </section>
    </div>
  );
}

function renderSkeleton(kind: LoadingSkeleton): ReactNode {
  switch (kind) {
    case "tree":
      return <TreeSkeleton />;
    case "blob":
      return <BlobSkeleton />;
    case "commits":
      return <CommitsSkeleton />;
    case "branches":
      return <BranchesSkeleton />;
    case "refs":
      return <RefsSkeleton />;
    case "blame":
      return <BlameSkeleton />;
    case "sidebar":
      return <SidebarSkeleton />;
    case "readme":
      return <ReadmeSkeleton />;
    case "auth":
      return <AuthSkeleton />;
    case "people":
      return <PeopleSkeleton />;
    case "cards":
      return <CardsSkeleton />;
    case "landing":
      return <LandingSkeleton />;
    case "discover":
      return <DiscoverSkeleton />;
    default:
      return null;
  }
}

/**
 * Content-area loading: wireframe skeleton placeholders + muted status.
 * Optional children still get a light veil if provided.
 */
export function PageLoadingOverlay({
  message = "Loading…",
  skeleton,
  children,
  className,
}: {
  message?: ReactNode;
  skeleton?: LoadingSkeleton;
  children?: ReactNode;
  className?: string;
}) {
  const hasChildren = children != null;
  const hasSkeleton = skeleton != null;

  return (
    <div
      className={[
        "page-loading",
        hasSkeleton ? "page-loading--skeleton" : null,
        !hasChildren && !hasSkeleton ? "page-loading--solo" : null,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      {hasSkeleton ? (
        <>
          {message ? (
            <p className="page-loading__status page-loading__status--above">
              {message}
            </p>
          ) : null}
          {renderSkeleton(skeleton)}
        </>
      ) : null}
      {hasChildren ? <div className="page-loading__content">{children}</div> : null}
      {!hasSkeleton ? (
        <div className="page-loading__veil">
          <div className="page-loading__shimmer" aria-hidden />
          <p className="page-loading__status">{message}</p>
        </div>
      ) : null}
    </div>
  );
}

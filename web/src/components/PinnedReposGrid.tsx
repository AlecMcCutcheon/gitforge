/**
 * GitHub-style pinned repo grid: icon, name, Public badge, grab+DnD (self),
 * language + stars. Reorder autosaves via onReorder.
 */
import { useRef, useState, type DragEvent } from "react";
import { Link } from "../spa-link";
import { brand } from "../lib/brand";
import { repoHref, repoPathDisplay } from "../lib/repo-path";

export interface PinnedRepoCard {
  prefix: string;
  label: string;
  name: string | null;
  description: string | null;
  ownerFingerprint: string | null;
  /** ForgeRegistry primary language cache; omit when unknown. */
  language: string | null;
  languageColor: string | null;
  starCount: number;
  registration: "registered" | "unregistered";
}

function RepoBookIcon() {
  return (
    <svg
      className="octicon pinned-card-repo-icon"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      aria-hidden
    >
      <path
        fill="currentColor"
        d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 10h8ZM4.5 1A1.5 1.5 0 0 0 3 2.5V7h1.5a.75.75 0 0 1 0 1.5H3v3.5A1.5 1.5 0 0 0 4.5 13.5h8.75V1.5Z"
      />
    </svg>
  );
}

function GrabHandleIcon() {
  return (
    <svg
      className="octicon"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      aria-hidden
    >
      <path
        fill="currentColor"
        d="M10 13a1 1 0 1 1 0-2 1 1 0 0 1 0 2Zm0-4a1 1 0 1 1 0-2 1 1 0 0 1 0 2Zm-4 4a1 1 0 1 1 0-2 1 1 0 0 1 0 2Zm0-4a1 1 0 1 1 0-2 1 1 0 0 1 0 2Zm0-4a1 1 0 1 1 0-2 1 1 0 0 1 0 2Zm4 0a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"
      />
    </svg>
  );
}

function StarIcon() {
  return (
    <svg
      className="octicon"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      aria-hidden
    >
      <path
        fill="currentColor"
        d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z"
      />
    </svg>
  );
}

export interface PinnedReposGridProps {
  cards: PinnedRepoCard[];
  /** Own profile: drag handles + reorder. */
  canReorder?: boolean;
  /** Own profile + missing lang: quiet pending hint. */
  showLangPending?: boolean;
  onReorder?: (orderedPrefixes: string[]) => void;
  empty: string;
}

export function PinnedReposGrid({
  cards,
  canReorder = false,
  showLangPending = false,
  onReorder,
  empty,
}: PinnedReposGridProps) {
  const dragFrom = useRef<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  if (cards.length === 0) {
    return <p className="muted">{empty}</p>;
  }

  const move = (from: number, to: number) => {
    if (from === to || from < 0 || to < 0 || from >= cards.length || to >= cards.length) {
      return;
    }
    const next = [...cards];
    const [item] = next.splice(from, 1);
    if (!item) return;
    next.splice(to, 0, item);
    onReorder?.(next.map((c) => c.prefix));
  };

  const onDragStart = (i: number) => (e: DragEvent) => {
    if (!canReorder) return;
    dragFrom.current = i;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(i));
  };

  const onDragOver = (i: number) => (e: DragEvent) => {
    if (!canReorder || dragFrom.current == null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOver(i);
  };

  const onDrop = (i: number) => (e: DragEvent) => {
    if (!canReorder) return;
    e.preventDefault();
    const from = dragFrom.current;
    dragFrom.current = null;
    setDragOver(null);
    if (from == null) return;
    move(from, i);
  };

  const onDragEnd = () => {
    dragFrom.current = null;
    setDragOver(null);
  };

  return (
    <ul className="pinned-grid">
      {cards.map((c, i) => {
        const opts = c.ownerFingerprint
          ? { ownerFingerprint: c.ownerFingerprint }
          : undefined;
        const title = c.name?.trim() || c.label;
        const href = repoHref(c.prefix, c.label, "", opts);
        return (
          <li
            key={c.prefix}
            className={
              dragOver === i
                ? "pinned-card-wrap pinned-card-wrap--over"
                : "pinned-card-wrap"
            }
            draggable={canReorder}
            onDragStart={onDragStart(i)}
            onDragOver={onDragOver(i)}
            onDrop={onDrop(i)}
            onDragEnd={onDragEnd}
          >
            <article className="pinned-card">
              <div className="pinned-card-head">
                <RepoBookIcon />
                <Link to={href} className="pinned-card-name">
                  {title}
                </Link>
                <span
                  className="gh-badge pinned-card-vis"
                  title={
                    c.registration === "registered"
                      ? `Listed on ${brand.registryName}`
                      : "Not on ForgeRegistry"
                  }
                >
                  {c.registration === "registered" ? "Public" : "Unlisted"}
                </span>
                {canReorder ? (
                  <span
                    className="pinned-card-grab"
                    title="Drag to reorder"
                    aria-label="Drag to reorder"
                  >
                    <GrabHandleIcon />
                  </span>
                ) : null}
              </div>
              {c.description?.trim() ? (
                <p className="pinned-card-desc muted">{c.description.trim()}</p>
              ) : (
                <p className="pinned-card-desc muted tiny mono">
                  {repoPathDisplay(c.prefix, c.label, opts)}
                </p>
              )}
              <div className="pinned-card-meta">
                {c.language ? (
                  <span className="pinned-card-lang">
                    <span
                      className="pinned-card-lang-dot"
                      style={{ background: c.languageColor || "#858585" }}
                      aria-hidden
                    />
                    {c.language}
                  </span>
                ) : showLangPending ? (
                  <span className="pinned-card-lang muted tiny">
                    Language pending
                  </span>
                ) : null}
                <span className="pinned-card-stars" title="Stars">
                  <StarIcon />
                  {c.starCount}
                </span>
              </div>
            </article>
          </li>
        );
      })}
    </ul>
  );
}

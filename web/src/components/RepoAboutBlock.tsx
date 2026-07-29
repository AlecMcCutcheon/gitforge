/**
 * Repo sidebar About: description (RepoState), website + topics (HubRegistry).
 * Gear / edit only for registry owner on a registered listing.
 */
import { useEffect, useState } from "react";
import { api, type HubRegistration } from "../api";
import { EditAboutModal } from "./EditAboutModal";

export interface RepoAboutBlockProps {
  prefix: string;
  label: string;
  /** Signed RepoState display name (for registry upsert). */
  name?: string | null;
  /** Repo contract description (source of truth for About text). */
  description: string | null;
  registration: HubRegistration | null;
  /** Registry owner only — shows gear + edit modal. */
  canEdit: boolean;
  onDescriptionSaved?: (description: string) => void;
  onRegistrationSaved?: (registration: HubRegistration) => void;
  /** Fallback when description empty and no website/topics (empty vs filled repo). */
  emptyHint?: string;
}

function GearIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M8 4.754a3.246 3.246 0 1 0 0 6.492 3.246 3.246 0 0 0 0-6.492zM5.754 8a2.246 2.246 0 1 1 4.492 0 2.246 2.246 0 0 1-4.492 0z" />
      <path d="M9.796 1.343c-.527-1.79-3.065-1.79-3.592 0l-.094.319a.873.873 0 0 1-1.255.52l-.292-.16c-1.64-.892-3.433.902-2.54 2.541l.159.292a.873.873 0 0 1-.52 1.255l-.319.094c-1.79.527-1.79 3.065 0 3.592l.319.094a.873.873 0 0 1 .52 1.255l-.16.292c-.892 1.64.901 3.434 2.541 2.54l.292-.159a.873.873 0 0 1 1.255.52l.094.319c.527 1.79 3.065 1.79 3.592 0l.094-.319a.873.873 0 0 1 1.255-.52l.292.16c1.64.893 3.434-.902 2.54-2.541l-.159-.292a.873.873 0 0 1 .52-1.255l.319-.094c1.79-.527 1.79-3.065 0-3.592l-.319-.094a.873.873 0 0 1-.52-1.255l.16-.292c.893-1.64-.902-3.433-2.541-2.54l-.292.159a.873.873 0 0 1-1.255-.52l-.094-.319zm-2.633.283c.246-.835 1.428-.835 1.674 0l.094.319a1.873 1.873 0 0 0 2.693 1.115l.291-.16c.764-.415 1.6.42 1.184 1.185l-.159.292a1.873 1.873 0 0 0 1.115 2.693l.319.094c.835.246.835 1.428 0 1.674l-.319.094a1.873 1.873 0 0 0-1.115 2.693l.16.291c.415.764-.42 1.6-1.185 1.184l-.291-.159a1.873 1.873 0 0 0-2.693 1.115l-.094.319c-.246.835-1.428.835-1.674 0l-.094-.319a1.873 1.873 0 0 0-2.693-1.115l-.292.16c-.764.415-1.6-.42-1.184-1.185l.159-.291A1.873 1.873 0 0 0 1.945 8.93l-.319-.094c-.835-.246-.835-1.428 0-1.674l.319-.094A1.873 1.873 0 0 0 3.06 4.377l-.16-.292c-.415-.764.42-1.6 1.185-1.184l.292.159a1.873 1.873 0 0 0 2.693-1.115l.094-.319z" />
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M7.775 3.275a.75.75 0 0 0 1.06 1.06l1.25-1.25a2 2 0 1 1 2.83 2.83l-2.5 2.5a2 2 0 0 1-2.83 0 .75.75 0 0 0-1.06 1.06 3.5 3.5 0 0 0 4.95 0l2.5-2.5a3.5 3.5 0 0 0-4.95-4.95l-1.25 1.25zm-4.69 9.64a2 2 0 0 1 0-2.83l2.5-2.5a2 2 0 0 1 2.83 0 .75.75 0 0 0 1.06-1.06 3.5 3.5 0 0 0-4.95 0l-2.5 2.5a3.5 3.5 0 0 0 4.95 4.95l1.25-1.25a.75.75 0 0 0-1.06-1.06l-1.25 1.25a2 2 0 0 1-2.83 0z" />
    </svg>
  );
}

function displayWebsiteHref(raw: string): string {
  const t = raw.trim();
  if (/^https?:\/\//i.test(t)) return t;
  return `https://${t}`;
}

function truncateUrl(raw: string, max = 36): string {
  const t = raw.trim().replace(/^https?:\/\//i, "");
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

export function RepoAboutBlock({
  prefix,
  label,
  name,
  description,
  registration,
  canEdit,
  onDescriptionSaved,
  onRegistrationSaved,
  emptyHint = "No description, website, or topics provided.",
}: RepoAboutBlockProps) {
  const [editOpen, setEditOpen] = useState(false);
  const [localDesc, setLocalDesc] = useState<string | null>(null);
  const [localReg, setLocalReg] = useState<HubRegistration | null>(null);
  // NEW CODE - TESTING: Pages site URL for About “use same as Pages” checkbox
  const [pagesSiteUrl, setPagesSiteUrl] = useState<string | null>(null);

  const desc = localDesc ?? description;
  const reg = localReg ?? registration;
  const website = (reg?.website ?? "").trim();
  const topics = reg?.topics ?? [];
  const hasAbout =
    Boolean(desc?.trim()) || Boolean(website) || topics.length > 0;

  useEffect(() => {
    if (!canEdit) {
      setPagesSiteUrl(null);
      return;
    }
    let cancelled = false;
    void api
      .pages(prefix, label, false)
      .then((row) => {
        if (cancelled) return;
        // Only after a successful deploy is pages.enabled + siteUrl set
        setPagesSiteUrl(
          row.enabled && row.siteUrl ? row.siteUrl : null,
        );
      })
      .catch(() => {
        if (!cancelled) setPagesSiteUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [canEdit, prefix, label, editOpen]);

  return (
    <section className="gh-side-block gh-about-block">
      <div className="gh-about-head">
        <h3>About</h3>
        {canEdit ? (
          <button
            type="button"
            className="gh-about-gear"
            aria-label="Edit repository details"
            title="Edit repository details"
            onClick={() => setEditOpen(true)}
          >
            <GearIcon />
          </button>
        ) : null}
      </div>

      {hasAbout ? (
        <>
          {desc?.trim() ? <p className="gh-about-desc">{desc.trim()}</p> : null}
          {website ? (
            <p className="gh-about-website">
              <LinkIcon />
              <a
                href={displayWebsiteHref(website)}
                target="_blank"
                rel="noopener noreferrer"
                title={website}
              >
                {truncateUrl(website)}
              </a>
            </p>
          ) : null}
          {topics.length > 0 ? (
            <ul className="gh-about-topic-pills">
              {topics.map((t) => (
                <li key={t}>
                  <span className="gh-about-topic-pill">{t}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : (
        <p className="gh-about-empty muted">{emptyHint}</p>
      )}

      {canEdit ? (
        <EditAboutModal
          open={editOpen}
          onClose={() => setEditOpen(false)}
          prefix={prefix}
          label={label}
          name={name}
          description={desc ?? ""}
          website={website}
          topics={[...topics]}
          pagesSiteUrl={pagesSiteUrl}
          onSaved={({ description: nextDesc, registration: nextReg }) => {
            setLocalDesc(nextDesc);
            setLocalReg(nextReg);
            onDescriptionSaved?.(nextDesc);
            onRegistrationSaved?.(nextReg);
          }}
        />
      ) : null}
    </section>
  );
}

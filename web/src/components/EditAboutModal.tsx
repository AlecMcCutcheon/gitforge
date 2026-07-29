/**
 * GitHub-style "Edit repository details" for About (description / website / topics).
 * Description → RepoState; website + topics → HubRegistry (owner dual-sig).
 */
import { useEffect, useState } from "react";
import { api, type HubRegistration } from "../api";
import { FlashNotice } from "./FlashNotice";
import { BusyLabel, OperationStatus } from "./OperationStatus";
import { defaultBusyLabel } from "../lib/busy-copy";

const DESC_MAX = 350;
const MAX_TOPICS = 20;
const TOPIC_MAX_LEN = 50;

export interface EditAboutModalProps {
  open: boolean;
  onClose: () => void;
  prefix: string;
  label: string;
  name?: string | null;
  description: string;
  website: string;
  topics: string[];
  /** When Pages is enabled, offer to fill Website from the deployed site URL. */
  pagesSiteUrl?: string | null;
  onSaved: (next: {
    description: string;
    registration: HubRegistration;
  }) => void;
}

function normalizeTopic(raw: string): string | null {
  const t = raw.trim().toLowerCase().replace(/\s+/g, "-");
  if (!t) return null;
  if (t.length > TOPIC_MAX_LEN) return t.slice(0, TOPIC_MAX_LEN);
  return t;
}

export function EditAboutModal({
  open,
  onClose,
  prefix,
  label,
  name,
  description: initialDescription,
  website: initialWebsite,
  topics: initialTopics,
  pagesSiteUrl = null,
  onSaved,
}: EditAboutModalProps) {
  const [description, setDescription] = useState(initialDescription);
  const [website, setWebsite] = useState(initialWebsite);
  const [topics, setTopics] = useState<string[]>(initialTopics);
  const [topicDraft, setTopicDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // NEW CODE - TESTING: optional “same as Pages” fill for Website
  const [usePagesSite, setUsePagesSite] = useState(false);

  const pagesUrl = (pagesSiteUrl ?? "").trim();
  const pagesAvailable = Boolean(pagesUrl);

  useEffect(() => {
    if (!open) return;
    setDescription(initialDescription);
    setWebsite(initialWebsite);
    setTopics(initialTopics);
    setTopicDraft("");
    setError(null);
    setBusy(false);
    const initial = initialWebsite.trim();
    const match =
      Boolean(pagesUrl) &&
      initial.length > 0 &&
      (initial === pagesUrl ||
        initial.replace(/\/$/, "") === pagesUrl.replace(/\/$/, ""));
    setUsePagesSite(match);
  }, [open, initialDescription, initialWebsite, initialTopics, pagesUrl]);

  if (!open) return null;

  const remaining = DESC_MAX - description.length;

  function addTopicFromDraft() {
    const parts = topicDraft.split(/[,\s]+/);
    let next = [...topics];
    for (const part of parts) {
      const t = normalizeTopic(part);
      if (!t) continue;
      if (next.includes(t)) continue;
      if (next.length >= MAX_TOPICS) break;
      next = [...next, t];
    }
    setTopics(next);
    setTopicDraft("");
  }

  function removeTopic(t: string) {
    setTopics((prev) => prev.filter((x) => x !== t));
  }

  async function onSave() {
    if (busy) return;
    if (description.length > DESC_MAX) {
      setError(`Description must be at most ${DESC_MAX} characters.`);
      return;
    }
    const site =
      usePagesSite && pagesAvailable ? pagesUrl : website.trim();
    if (site && !/^https?:\/\//i.test(site) && !site.includes(".")) {
      setError("Enter a valid URL for the website.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api.updateRepoAbout({
        prefix,
        label,
        name: name ?? undefined,
        description,
        website: site || null,
        topics,
      });
      onSaved(result);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="gh-collab-modal-backdrop"
      role="presentation"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <div
        className="gh-collab-modal gh-about-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="gh-about-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="gh-collab-modal-head">
          <h2 id="gh-about-modal-title">Edit repository details</h2>
          <button
            type="button"
            className="gh-collab-modal-close"
            aria-label="Close"
            disabled={busy}
            onClick={onClose}
          >
            ×
          </button>
        </header>

        {error ? (
          <FlashNotice variant="error" onDismiss={() => setError(null)}>
            {error}
          </FlashNotice>
        ) : null}

        <label className="gh-about-field">
          <span className="gh-about-field-label">Description</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value.slice(0, DESC_MAX))}
            placeholder="Short description of this repository."
            rows={3}
            disabled={busy}
            maxLength={DESC_MAX}
          />
          <span className="gh-about-field-hint muted">
            {remaining} characters remaining.
          </span>
        </label>

        <label className="gh-about-field">
          <span className="gh-about-field-label">Website</span>
          <input
            type="url"
            value={website}
            onChange={(e) => {
              setUsePagesSite(false);
              setWebsite(e.target.value);
            }}
            placeholder="Enter a valid URL."
            disabled={busy || (usePagesSite && pagesAvailable)}
            autoComplete="url"
          />
          {/* NEW CODE - TESTING: fill from deployed Pages URL when enabled */}
          {pagesAvailable ? (
            <label className="account-check gh-about-pages-check">
              <input
                type="checkbox"
                checked={usePagesSite}
                disabled={busy}
                onChange={(e) => {
                  const on = e.target.checked;
                  setUsePagesSite(on);
                  if (on) setWebsite(pagesUrl);
                }}
              />
              Use the same as Pages (site is enabled)
            </label>
          ) : null}
        </label>

        <div className="gh-about-field">
          <span className="gh-about-field-label">Topics</span>
          {topics.length > 0 ? (
            <ul className="gh-about-topic-pills gh-about-topic-pills--edit">
              {topics.map((t) => (
                <li key={t}>
                  <button
                    type="button"
                    className="gh-about-topic-pill"
                    disabled={busy}
                    onClick={() => removeTopic(t)}
                    title={`Remove ${t}`}
                  >
                    {t}
                    <span aria-hidden="true"> ×</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <input
            type="text"
            value={topicDraft}
            onChange={(e) => setTopicDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                addTopicFromDraft();
              }
            }}
            onBlur={() => {
              if (topicDraft.trim()) addTopicFromDraft();
            }}
            placeholder="Add topics."
            disabled={busy || topics.length >= MAX_TOPICS}
            aria-label="Add topics"
          />
          <span className="gh-about-field-hint muted">
            Press Enter or comma to add. Up to {MAX_TOPICS} topics.
          </span>
        </div>

        <OperationStatus
          active={busy}
          scenario="about-save"
        />

        <div className="gh-collab-modal-actions">
          <button
            type="button"
            className="btn secondary"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={busy}
            onClick={() => void onSave()}
          >
            <BusyLabel
              busy={busy}
              idleText="Save changes"
              busyText={defaultBusyLabel("about-save")}
            />
          </button>
        </div>
      </div>
    </div>
  );
}

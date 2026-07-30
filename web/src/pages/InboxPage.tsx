import { useEffect, useMemo, useState } from "react";
import { Navigate } from "react-router-dom";
import {
  acceptRepoInvite,
  denyRepoInvite,
  getCachedIdentity,
  listInboxDone,
  listInboxPlaintexts,
  onAuthSessionChange,
  refreshInboxSession,
  type InboxDoneItem,
} from "../freenet/auth-api";
import type { DecryptedInboxMessage } from "../freenet/inbox-crypto";
import {
  isSelfSignedInbox,
  isSystemInboxKind,
  type SystemNotifyBody,
} from "../freenet/system-notify";
import {
  REPO_INVITE_KIND,
  type RepoInviteBody,
} from "../freenet/repo-invite";
import { FlashNotice } from "../components/FlashNotice";
import { BusyLabel, OperationStatus } from "../components/OperationStatus";
import { PageLoadingOverlay } from "../components/PageLoadingOverlay";
import { isBrowserNativeMode } from "../tip-browse";
import { brand } from "../lib/brand";
import { useDocumentTitle } from "../lib/document-title";

type InboxNav = "inbox" | "done";
type ReadFilter = "all" | "unread";

function inviteBody(msg: DecryptedInboxMessage): RepoInviteBody | null {
  if (msg.plaintext?.kind !== REPO_INVITE_KIND) return null;
  const body = msg.plaintext.body as RepoInviteBody;
  if (!body?.prefix || !body?.secret_hex) return null;
  return body;
}

function systemBody(msg: DecryptedInboxMessage): SystemNotifyBody | null {
  if (!isSystemInboxKind(msg.plaintext?.kind)) return null;
  const body = msg.plaintext?.body as SystemNotifyBody | undefined;
  if (!body || typeof body !== "object") return null;
  return {
    title: typeof body.title === "string" ? body.title : "System",
    detail: typeof body.detail === "string" ? body.detail : undefined,
    prefix: typeof body.prefix === "string" ? body.prefix : undefined,
  };
}

function isSystemMessage(
  msg: DecryptedInboxMessage,
  selfVk: string | null,
): boolean {
  if (isSystemInboxKind(msg.plaintext?.kind)) return true;
  return isSelfSignedInbox(msg.sender_vk, selfVk);
}

export function InboxPage() {
  const websiteMode = isBrowserNativeMode();
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const [signedIn, setSignedIn] = useState(() => getCachedIdentity() != null);
  // — hard refresh cleared cache → Navigate to /identity before probe finished
  // NEW CODE - TESTING: wait for session probe like NewRepo / Account
  const [sessionReady, setSessionReady] = useState(false);
  const [signedIn, setSignedIn] = useState(() => getCachedIdentity() != null);
  const [nav, setNav] = useState<InboxNav>("inbox");
  useDocumentTitle(nav === "done" ? "Done" : "Inbox");
  const [filter, setFilter] = useState<ReadFilter>("all");
  const [query, setQuery] = useState("");
  const [messages, setMessages] = useState<DecryptedInboxMessage[]>([]);
  const [done, setDone] = useState<InboxDoneItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [opStep, setOpStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // sync() set sessionReady=true immediately while cache was empty on hard
    // refresh → Navigate to /identity?restore=1 before currentIdentity() returned.
    // const sync = () => {
    //   if (cancelled) return;
    //   setSignedIn(getCachedIdentity() != null);
    //   setSessionReady(true);
    // };
    // sync();
    // if (!getCachedIdentity() && websiteMode) {
    //   void import(...).then(({ currentIdentity }) => currentIdentity())...
    // }
    // NEW CODE - TESTING: always await currentIdentity before sessionReady (NewRepo)
    void (async () => {
      try {
        const { currentIdentity } = await import("../freenet/auth-api");
        const id = await currentIdentity();
        if (cancelled) return;
        setSignedIn(Boolean(id));
      } catch {
        if (cancelled) return;
        setSignedIn(getCachedIdentity() != null);
      } finally {
        if (!cancelled) setSessionReady(true);
      }
    })();
    const unsub = onAuthSessionChange(() => {
      if (cancelled) return;
      setSignedIn(getCachedIdentity() != null);
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [websiteMode]);

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      const msgs = await refreshInboxSession();
      setMessages(msgs);
      setDone(listInboxDone());
    } catch (e) {
      setMessages(listInboxPlaintexts());
      setDone(listInboxDone());
      // OLD CODE - KEEP UNTIL CONFIRMED WORKING
      // setError(e instanceof Error ? e.message : String(e));
      // NEW CODE - TESTING: WS 1006 is transient — friendlier copy + cached msgs
      const raw = e instanceof Error ? e.message : String(e);
      if (/Connection closed|1006|WebSocket|timed out|timeout/i.test(raw)) {
        setError(
          "Couldn't refresh inbox over Freenet (connection dropped). Try Refresh again.",
        );
      } else {
        setError(raw);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!websiteMode || !sessionReady || !signedIn) {
      if (sessionReady) setLoading(false);
      return;
    }
    void reload();
  }, [websiteMode, sessionReady, signedIn]);

  // NEW CODE - TESTING: background system notify → refresh list without manual Reload
  useEffect(() => {
    if (!websiteMode || !sessionReady || !signedIn) return;
    const onUpdated = () => {
      void refreshInboxSession()
        .then(setMessages)
        .catch(() => {
          setMessages(listInboxPlaintexts());
        });
    };
    window.addEventListener("gitforge-inbox-updated", onUpdated);
    return () => {
      window.removeEventListener("gitforge-inbox-updated", onUpdated);
    };
  }, [websiteMode, sessionReady, signedIn]);

  const selfVk = getCachedIdentity()?.public_key_b58 ?? null;

  const filteredInbox = useMemo(() => {
    const q = query.trim().toLowerCase();
    return messages.filter((m) => {
      if (filter === "unread") {
        /* all live inbox messages are unread until accept/deny removes them */
      }
      if (!q) return true;
      const body = inviteBody(m);
      const hay = [
        m.id,
        m.plaintext?.kind,
        body?.prefix,
        body?.label,
        body?.repo_name,
        m.sender_vk,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [messages, filter, query]);

  const filteredDone = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return done;
    return done.filter((d) =>
      `${d.summary} ${d.kind} ${d.outcome}`.toLowerCase().includes(q),
    );
  }, [done, query]);

  if (!websiteMode) {
    return (
      <main className="page">
        <p className="muted">Inbox is available on the Freenet-hosted website.</p>
      </main>
    );
  }

  if (!sessionReady) {
    return <PageLoadingOverlay skeleton="auth" message="" />;
  }

  if (!signedIn) {
    return <Navigate to="/identity?restore=1" replace />;
  }

  const onAccept = (id: string) => {
    setBusyId(id);
    setOpStep("Accepting invite…");
    setError(null);
    void (async () => {
      try {
        await acceptRepoInvite(id);
        setNote("Invite accepted — site key imported.");
        await reload();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyId(null);
        setOpStep(null);
      }
    })();
  };

  const onDeny = (id: string) => {
    setBusyId(id);
    setOpStep("Declining and scrubbing sealed key…");
    setError(null);
    void (async () => {
      try {
        await denyRepoInvite(id);
        setNote("Declined — sealed invite removed from Freenet.");
        setNav("done");
        await reload();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyId(null);
        setOpStep(null);
      }
    })();
  };

  return (
    <main className="inbox-page">
      <aside className="inbox-sidebar" aria-label="Inbox">
        <button
          type="button"
          className={nav === "inbox" ? "inbox-nav-item active" : "inbox-nav-item"}
          onClick={() => setNav("inbox")}
        >
          Inbox
        </button>
        <button
          type="button"
          className="inbox-nav-item inbox-nav-item--soon"
          disabled
          title="Not implemented yet"
        >
          Saved
        </button>
        <button
          type="button"
          className={nav === "done" ? "inbox-nav-item active" : "inbox-nav-item"}
          onClick={() => setNav("done")}
        >
          Done
        </button>
        <div className="inbox-nav-sep" />
        <button type="button" className="inbox-nav-item inbox-nav-item--soon" disabled>
          Assigned
        </button>
        <button type="button" className="inbox-nav-item inbox-nav-item--soon" disabled>
          Participating
        </button>
        <button type="button" className="inbox-nav-item inbox-nav-item--soon" disabled>
          Mentioned
        </button>
        <button type="button" className="inbox-nav-item inbox-nav-item--soon" disabled>
          Review requested
        </button>
      </aside>

      <section className="inbox-main">
        {error ? (
          <FlashNotice variant="error" onDismiss={() => setError(null)}>
            {error}
          </FlashNotice>
        ) : null}
        {note ? (
          <FlashNotice variant="success" onDismiss={() => setNote(null)}>
            {note}
          </FlashNotice>
        ) : null}

        <div className="inbox-toolbar">
          <div className="inbox-seg" role="group" aria-label="Filter">
            <button
              type="button"
              className={filter === "all" ? "active" : ""}
              onClick={() => setFilter("all")}
            >
              All
            </button>
            <button
              type="button"
              className={filter === "unread" ? "active" : ""}
              onClick={() => setFilter("unread")}
            >
              Unread
            </button>
          </div>
          <label className="inbox-search">
            <span className="visually-hidden">Search notifications</span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search notifications"
            />
          </label>
          <button
            type="button"
            className="btn secondary"
            disabled={loading || busyId != null}
            onClick={() => void reload()}
          >
            Refresh
          </button>
        </div>

        {busyId ? (
          <OperationStatus
            active
            scenario={opStep?.includes("Declin") ? "inbox-deny" : "inbox-accept"}
            step={opStep}
          />
        ) : null}

        {loading ? (
          <PageLoadingOverlay skeleton="cards" message="Loading inbox…" />
        ) : nav === "inbox" ? (
          filteredInbox.length === 0 ? (
            <div className="inbox-empty">
              <h2>All caught up!</h2>
              <p className="muted">
                No pending invites. Collaborator invites show up here as sealed
                site-key messages.
              </p>
            </div>
          ) : (
            <ul className="inbox-list">
              {filteredInbox.map((m) => {
                const body = inviteBody(m);
                if (body) {
                  const title =
                    body.repo_name || body.label || body.prefix;
                  return (
                    <li key={m.id} className="inbox-item">
                      <p className="inbox-item-title">
                        Repository access invite: {title}
                      </p>
                      <p className="inbox-item-meta mono break">
                        {body.prefix}
                        {m.sender_vk ? ` · from ${m.sender_vk}` : ""}
                        {m.created_at ? ` · ${m.created_at}` : ""}
                      </p>
                      <p className="muted tiny">
                        Accepting imports this repo’s Freenet site key into your
                        identity delegate (not your identity seed). You will be
                        able to push from {brand.displayName} and the CLI. Only accept from
                        people you trust — access cannot be revoked later without
                        rotating the key.
                      </p>
                      <div className="inbox-item-actions">
                        <button
                          type="button"
                          className="btn primary"
                          disabled={busyId != null}
                          onClick={() => onAccept(m.id)}
                        >
                          <BusyLabel
                            busy={busyId === m.id}
                            busyText="Accepting…"
                            idleText="Accept"
                          />
                        </button>
                        <button
                          type="button"
                          className="btn secondary"
                          disabled={busyId != null}
                          onClick={() => onDeny(m.id)}
                        >
                          <BusyLabel
                            busy={busyId === m.id}
                            busyText="Declining…"
                            idleText="Deny"
                          />
                        </button>
                      </div>
                    </li>
                  );
                }
                if (isSystemMessage(m, selfVk)) {
                  const sys = systemBody(m);
                  const title =
                    sys?.title ||
                    (isSystemInboxKind(m.plaintext?.kind)
                      ? "System"
                      : "System message");
                  return (
                    <li key={m.id} className="inbox-item inbox-item--system">
                      <p className="inbox-item-title">
                        <span className="inbox-system-badge">System</span>{" "}
                        {title}
                      </p>
                      {sys?.detail ? (
                        <p className="inbox-item-meta">{sys.detail}</p>
                      ) : null}
                      {sys?.prefix ? (
                        <p className="mono tiny muted break">{sys.prefix}</p>
                      ) : null}
                      <p className="inbox-item-meta muted tiny">
                        {m.created_at}
                        {m.error ? ` · ${m.error}` : ""}
                      </p>
                      <button
                        type="button"
                        className="btn secondary"
                        disabled={busyId != null}
                        onClick={() => onDeny(m.id)}
                      >
                        Dismiss
                      </button>
                    </li>
                  );
                }
                return (
                  <li key={m.id} className="inbox-item">
                    <p className="inbox-item-title">
                      {m.plaintext?.kind || "Message"}
                      {m.error ? " (could not decrypt)" : ""}
                    </p>
                    <p className="inbox-item-meta">
                      {m.created_at}
                      {m.sender_vk ? ` · from ${m.sender_vk}` : ""}
                      {m.error ? ` · ${m.error}` : ""}
                    </p>
                    <button
                      type="button"
                      className="btn secondary"
                      disabled={busyId != null}
                      onClick={() => onDeny(m.id)}
                    >
                      Dismiss
                    </button>
                  </li>
                );
              })}
            </ul>
          )
        ) : filteredDone.length === 0 ? (
          <div className="inbox-empty">
            <h2>Nothing in Done</h2>
            <p className="muted">Accepted or declined invites appear here locally.</p>
          </div>
        ) : (
          <ul className="inbox-list">
            {filteredDone.map((d) => (
              <li key={`${d.id}-${d.at}`} className="inbox-item">
                <p className="inbox-item-title">{d.summary}</p>
                <p className="inbox-item-meta">
                  {d.outcome} · {d.at}
                </p>
              </li>
            ))}
          </ul>
        )}
        {/* OLD CODE - KEEP UNTIL CONFIRMED WORKING
        <p className="muted tiny" style={{ marginTop: "1.5rem" }}>
          <Link to="/identity">Back to Settings</Link>
        </p>
        */}
        {/* NEW CODE - TESTING: Messages has its own nav; no stray Settings link */}
      </section>
    </main>
  );
}

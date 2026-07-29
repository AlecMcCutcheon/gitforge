import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "../spa-link";
import {
  currentIdentity,
  ensureSessionVaultId,
  getCachedIdentity,
  getCachedProfile,
  getSessionVaultId,
  loadPublicProfile,
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // logoutAccount,
  // NEW CODE - TESTING: confirm when delegate has repo backups
  confirmAndLogoutAccount,
  onAuthSessionChange,
} from "../freenet/auth-api";
import {
  fingerprintWordsJoined,
  peoplePath,
} from "../freenet/fingerprint-words";
import { EditStatusModal } from "./EditStatusModal";
import { HeaderCreateMenu } from "./HeaderCreateMenu";
import { ProfileAvatar } from "./ProfileAvatar";

function SmileIcon() {
  return (
    <svg className="octicon" viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path
        fill="currentColor"
        d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm4.75-2.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm3.5.75a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5.38 9.75a.75.75 0 0 1 .96-.44 3.001 3.001 0 0 0 3.32 0 .75.75 0 1 1 .52 1.406 4.501 4.501 0 0 1-4.36 0 .75.75 0 0 1-.44-.966Z"
      />
    </svg>
  );
}

/** Same repo glyph as HeaderCreateMenu / New repository. */
function RepoIcon() {
  return (
    <svg className="octicon" viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path
        fill="currentColor"
        d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 10h8ZM4.5 1A1.5 1.5 0 0 0 3 2.5V7h1.5a.75.75 0 0 1 0 1.5H3v3.5A1.5 1.5 0 0 0 4.5 13.5h8.75V1.5Z"
      />
    </svg>
  );
}

/** Profile / person — matches People nav silhouette style. */
function PersonIcon() {
  return (
    <svg className="octicon" viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path
        fill="currentColor"
        d="M10.561 8.073a6.005 6.005 0 0 1 3.432 5.142.75.75 0 1 1-1.498.07 4.5 4.5 0 0 0-8.99 0 .75.75 0 0 1-1.498-.07 6.004 6.004 0 0 1 3.431-5.142 3.999 3.999 0 1 1 5.123 0ZM10.5 5a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z"
      />
    </svg>
  );
}

/** Outline star — same idea as StarButton / Your stars. */
function StarIcon() {
  return (
    <svg className="octicon" viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path
        fill="currentColor"
        d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Zm0 2.445L6.615 5.5a.75.75 0 0 1-.564.41l-3.097.45 2.24 2.184a.75.75 0 0 1 .216.664l-.528 3.084 2.769-1.456a.75.75 0 0 1 .698 0l2.77 1.456-.53-3.084a.75.75 0 0 1 .216-.664l2.24-2.183-3.096-.45a.75.75 0 0 1-.564-.41L8 2.694Z"
      />
    </svg>
  );
}

/** Same gear as repo Settings tabs. */
function GearIcon() {
  return (
    <svg className="octicon" viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path
        fill="currentColor"
        d="M8 0a8.2 8.2 0 0 1 .691.031C9.444.198 10 1.048 10 1.998V3a2 2 0 0 0 2 2h1.002c.95 0 1.8.556 1.967 1.309a8.2 8.2 0 0 1 0 1.382C15.802 8.444 14.952 9 14.002 9H12a2 2 0 0 0-2 2v1.002c0 .95-.556 1.8-1.309 1.967a8.2 8.2 0 0 1-1.382 0C6.556 13.802 6 12.952 6 12.002V11a2 2 0 0 0-2-2H2.998c-.95 0-1.8-.556-1.967-1.309a8.2 8.2 0 0 1 0-1.382C1.198 5.556 2.048 5 2.998 5H4a2 2 0 0 0 2-2V1.998c0-.95.556-1.8 1.309-1.967A8.2 8.2 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0ZM8 5.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Z"
      />
    </svg>
  );
}

function SignOutIcon() {
  return (
    <svg className="octicon" viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path
        fill="currentColor"
        d="M2 2.75C2 1.784 2.784 1 3.75 1h2.5a.75.75 0 0 1 0 1.5h-2.5a.25.25 0 0 0-.25.25v10.5c0 .138.112.25.25.25h2.5a.75.75 0 0 1 0 1.5h-2.5A1.75 1.75 0 0 1 2 13.25Zm10.44 4.5-1.97-1.97a.749.749 0 0 1 1.06-1.06l3.25 3.25a.75.75 0 0 1 0 1.06l-3.25 3.25a.749.749 0 1 1-1.06-1.06l1.97-1.97H6.75a.75.75 0 0 1 0-1.5Z"
      />
    </svg>
  );
}

function AccountMenuItem({
  to,
  icon,
  children,
  onClick,
}: {
  to: string;
  icon: ReactNode;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <Link
      role="menuitem"
      to={to}
      className="account-menu-item"
      onClick={onClick}
    >
      <span className="account-menu-item-icon" aria-hidden>
        {icon}
      </span>
      <span>{children}</span>
    </Link>
  );
}

/** Top-right: Create/Restore when signed out; + and avatar menu when signed in. */
export function AccountHeaderLink() {
  const [vaultId, setVaultId] = useState(() => getSessionVaultId());
  const [fingerprint, setFingerprint] = useState(
    () => getCachedIdentity()?.fingerprint ?? null,
  );
  const [avatar, setAvatar] = useState(() => getCachedProfile()?.avatar ?? "");
  const [name, setName] = useState(() => getCachedIdentity()?.name ?? null);
  const [probeReady, setProbeReady] = useState(
    () => Boolean(getCachedIdentity() || getSessionVaultId()),
  );
  const [signedIn, setSignedIn] = useState(() => getCachedIdentity() != null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [signOutBusy, setSignOutBusy] = useState(false);
  // NEW CODE - TESTING: status in account menu + Edit status modal
  const [statusEmoji, setStatusEmoji] = useState("");
  const [statusText, setStatusText] = useState("");
  const [statusModalOpen, setStatusModalOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const sync = () => {
      const id = getCachedIdentity();
      setVaultId(getSessionVaultId());
      setFingerprint(id?.fingerprint ?? null);
      setAvatar(getCachedProfile()?.avatar ?? "");
      setName(id?.name ?? null);
      setSignedIn(id != null);
    };
    sync();
    const unsub = onAuthSessionChange(sync);
    void (async () => {
      try {
        if (!getSessionVaultId() || !getCachedIdentity()) {
          await currentIdentity().catch(() => null);
        }
        const id =
          getSessionVaultId() ??
          (await ensureSessionVaultId().catch(() => null));
        if (id) {
          setVaultId(id);
          setFingerprint(getCachedIdentity()?.fingerprint ?? null);
          setName(getCachedIdentity()?.name ?? null);
          setSignedIn(getCachedIdentity() != null);
          const fp = getCachedIdentity()?.fingerprint;
          if (fp) {
            const profile = await loadPublicProfile(fp).catch(() => null);
            if (profile) {
              setAvatar(profile.avatar);
              setStatusEmoji(profile.statusEmoji ?? "");
              setStatusText(profile.statusText ?? "");
            }
          }
          // NEW CODE - TESTING: resume vault Put if create/restore was interrupted
          const { ensureSignedInAccountVault, probeVaultBackupEnabled } =
            await import("../freenet/auth-api");
          const sid = getSessionVaultId();
          if (sid && !(await probeVaultBackupEnabled(sid).catch(() => false))) {
            void ensureSignedInAccountVault().catch(() => undefined);
          }
        }
      } finally {
        setProbeReady(true);
        setSignedIn(getCachedIdentity() != null);
      }
    })();
    return unsub;
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen || !fingerprint) return;
    void loadPublicProfile(fingerprint)
      .then((profile) => {
        if (!profile) return;
        setAvatar(profile.avatar);
        setStatusEmoji(profile.statusEmoji ?? "");
        setStatusText(profile.statusText ?? "");
      })
      .catch(() => undefined);
  }, [menuOpen, fingerprint]);

  if (!probeReady && !signedIn) {
    return (
      <span
        className="skel-bone skel-bone--avatar account-header-identicon"
        aria-hidden
      />
    );
  }

  if (!signedIn) {
    return (
      <div className="auth-header-actions">
        <Link to="/identity?restore=1" className="auth-header-text">
          Restore
        </Link>
        <Link to="/identity?create=1" className="btn auth-header-signup">
          Create
        </Link>
      </div>
    );
  }

  const wordSlug = fingerprint ? fingerprintWordsJoined(fingerprint) : "";
  const title = name
    ? `${name}${wordSlug ? ` · ${wordSlug}` : ""}`
    : "Identity";
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const profileBase = fingerprint
  //   ? `/people/${encodeURIComponent(fingerprint)}`
  //   : "/identity";
  // peoplePath already includes ?fp= — never append ?tab=
  // NEW CODE - TESTING: clean word URLs (?tab=repositories|stars only)
  const profileOverview = fingerprint ? peoplePath(fingerprint) : "/identity";
  const profileRepos = fingerprint
    ? peoplePath(fingerprint, { tab: "repositories" })
    : "/identity";
  const profileStars = fingerprint
    ? peoplePath(fingerprint, { tab: "stars" })
    : "/identity";

  const close = () => setMenuOpen(false);

  const onSignOut = () => {
    setSignOutBusy(true);
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // void logoutAccount()
    // NEW CODE - TESTING: warn if identity-delegate backups would be wiped
    void confirmAndLogoutAccount()
      .catch(() => undefined)
      .finally(() => {
        setSignOutBusy(false);
        setMenuOpen(false);
      });
  };

  return (
    <div className="account-header-cluster">
      <HeaderCreateMenu />
      {/* NEW CODE - TESTING: same chrome as + create (header-create-btn sizing) */}
      <Link
        to="/inbox"
        className="inbox-header-btn"
        title="Inbox"
        aria-label="Inbox"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
          <path
            fill="currentColor"
            d="M2.8 2h10.4c.83 0 1.5.67 1.5 1.5v9c0 .83-.67 1.5-1.5 1.5H2.8c-.83 0-1.5-.67-1.5-1.5v-9C1.3 2.67 1.97 2 2.8 2Zm0 1.5v1.09l5.2 3.12 5.2-3.12V3.5Zm10.4 2.42-4.76 2.85a1.25 1.25 0 0 1-1.28 0L2.8 5.92V12.5h10.4Z"
          />
        </svg>
      </Link>
      <div className="account-menu" ref={menuRef}>
        {/* OLD CODE - KEEP UNTIL CONFIRMED WORKING
        <NavLink to={profileBase} className="account-header-link">…</NavLink>
        */}
        {/* NEW CODE - TESTING: GitHub-style avatar dropdown */}
        <button
          type="button"
          className="account-header-link account-menu-trigger"
          title={title}
          aria-label="Account menu"
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          onClick={() => setMenuOpen((v) => !v)}
        >
          {fingerprint || vaultId || avatar ? (
            <ProfileAvatar
              fingerprint={fingerprint}
              vaultId={vaultId ?? ""}
              avatarUrl={avatar || null}
              size={32}
              className="account-header-identicon"
              title={title}
            />
          ) : (
            <span className="account-header-fallback" aria-hidden>
              <svg width="32" height="32" viewBox="0 0 28 28">
                <circle cx="14" cy="14" r="13" fill="#212830" stroke="#3d444d" />
                <circle cx="14" cy="11" r="4" fill="#9198a1" />
                <path
                  d="M6 22c1.8-4 5-6 8-6s6.2 2 8 6"
                  fill="none"
                  stroke="#9198a1"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            </span>
          )}
        </button>
        {menuOpen ? (
          <div className="account-menu-panel" role="menu">
            {/* OLD CODE - KEEP UNTIL CONFIRMED WORKING
            <div className="account-menu-header">
              <div className="account-menu-name">…</div>
              <div className="account-menu-fp">…</div>
            </div>
            */}
            {/* NEW CODE - TESTING: avatar + identity header like GitHub */}
            <div className="account-menu-header account-menu-header--ident">
              <div className="account-menu-header-avatar">
                {fingerprint || vaultId || avatar ? (
                  <ProfileAvatar
                    fingerprint={fingerprint}
                    vaultId={vaultId ?? ""}
                    avatarUrl={avatar || null}
                    size={40}
                    className="account-menu-avatar"
                    title={title}
                  />
                ) : (
                  <span className="account-header-fallback" aria-hidden>
                    <svg width="40" height="40" viewBox="0 0 28 28">
                      <circle
                        cx="14"
                        cy="14"
                        r="13"
                        fill="#212830"
                        stroke="#3d444d"
                      />
                      <circle cx="14" cy="11" r="4" fill="#9198a1" />
                      <path
                        d="M6 22c1.8-4 5-6 8-6s6.2 2 8 6"
                        fill="none"
                        stroke="#9198a1"
                        strokeWidth="2"
                        strokeLinecap="round"
                      />
                    </svg>
                  </span>
                )}
              </div>
              <div className="account-menu-header-text">
                <div className="account-menu-name">{name ?? "Signed in"}</div>
                {wordSlug ? (
                  <div
                    className="mono tiny muted account-menu-fp break"
                    title={fingerprint ?? undefined}
                  >
                    {wordSlug}
                  </div>
                ) : null}
              </div>
            </div>
            <div className="account-menu-sep" />
            <button
              type="button"
              role="menuitem"
              className="account-menu-item account-menu-item--button"
              onClick={() => {
                setMenuOpen(false);
                setStatusModalOpen(true);
              }}
            >
              <span className="account-menu-item-icon" aria-hidden>
                {statusEmoji ? (
                  <span className="account-menu-status-emoji">{statusEmoji}</span>
                ) : (
                  <SmileIcon />
                )}
              </span>
              <span className="account-menu-status-label">
                {statusText || (statusEmoji ? "Edit status" : "Set status")}
              </span>
            </button>
            <div className="account-menu-sep" />
            {/* OLD CODE - KEEP UNTIL CONFIRMED WORKING
            <Link …>Your profile</Link> (text-only items)
            */}
            {/* NEW CODE - TESTING: octicons matching create menu / settings / stars */}
            <AccountMenuItem
              to={profileOverview}
              icon={<PersonIcon />}
              onClick={close}
            >
              Your profile
            </AccountMenuItem>
            <AccountMenuItem
              to={profileRepos}
              icon={<RepoIcon />}
              onClick={close}
            >
              Your repositories
            </AccountMenuItem>
            <AccountMenuItem
              to={profileStars}
              icon={<StarIcon />}
              onClick={close}
            >
              Your stars
            </AccountMenuItem>
            <div className="account-menu-sep" />
            <AccountMenuItem to="/identity" icon={<GearIcon />} onClick={close}>
              Settings
            </AccountMenuItem>
            <button
              type="button"
              role="menuitem"
              className="account-menu-item account-menu-item--button danger"
              disabled={signOutBusy}
              onClick={onSignOut}
            >
              <span className="account-menu-item-icon" aria-hidden>
                <SignOutIcon />
              </span>
              <span>{signOutBusy ? "Signing out…" : "Sign out"}</span>
            </button>
          </div>
        ) : null}
      </div>
      {statusModalOpen ? (
        <EditStatusModal
          initialEmoji={statusEmoji}
          initialText={statusText}
          onClose={() => setStatusModalOpen(false)}
          onSaved={(emoji, text) => {
            setStatusEmoji(emoji);
            setStatusText(text);
          }}
        />
      ) : null}
    </div>
  );
}

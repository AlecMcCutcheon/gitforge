import { type FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Link } from "../spa-link";
import { repoHref, repoPathDisplay } from "../lib/repo-path";
import { BrandLogo } from "../components/BrandLogo";
import { EMBEDDED_DEMOS } from "../demos";
import { brand, registryLabel } from "../lib/brand";
import { useDocumentTitle } from "../lib/document-title";

function hubPathFromUrl(url: string): { prefix: string; label: string } | null {
  const m =
    /^(?:freenet::|freenet:)?([1-9A-HJ-NP-Za-km-z]{8,24})(?:\/([A-Za-z0-9._~-]+))?$/.exec(
      url.trim(),
    );
  if (!m) return null;
  return { prefix: m[1]!, label: m[2] ?? "repo" };
}

/**
 * Logged-out marketing home (GitHub-style hero).
 * Discover (registry + curated repos) stays at `/` when signed in.
 */
export function LandingPage() {
  useDocumentTitle(null);
  const navigate = useNavigate();
  const [username, setUsername] = useState("");

  const onQuickCreate = (e: FormEvent) => {
    e.preventDefault();
    const name = username.trim();
    const q = new URLSearchParams({ create: "1" });
    if (name) q.set("username", name);
    void navigate(`/identity?${q.toString()}`);
  };

  return (
    <main className="landing">
      <section className="landing-hero">
        <div className="landing-hero__glow" aria-hidden />
        <div className="landing-hero__inner">
          <p className="landing-kicker">
            <BrandLogo size={28} className="brand-logo" />
            {brand.displayName}
          </p>
          <p className="landing-badge muted">Unofficial community project</p>
          <h1 className="landing-title">
            A forge UI for git hosted on Freenet
          </h1>
          <p className="landing-lede">
            Built on <span className="mono">freenet-git</span>: browse tip packs
            in the browser, list repos on ForgeRegistry, star what you care about,
            and keep identities on your Freenet node — not a central account
            server. This is an early, unofficial layer while it matures alongside
            the upstream tooling.
          </p>

          <form className="landing-cta" onSubmit={onQuickCreate}>
            <input
              className="landing-cta__input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Choose a username"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              aria-label="Username for new identity"
            />
            <button type="submit" className="btn landing-cta__primary">
              Create identity
            </button>
            <Link
              to="/identity?restore=1"
              className="btn secondary landing-cta__secondary"
            >
              Restore identity
            </Link>
          </form>

          <p className="landing-footnote muted">
            Your keys stay in the Freenet identity delegate and vault.
            Download a freenet-git identity bundle when you create — there is
            no email reset.
          </p>
        </div>
      </section>

      <section className="landing-features">
        <article className="landing-feature">
          <h2>Browse without a full clone</h2>
          <p>
            Open a <span className="mono">freenet::prefix/label</span> repo in
            the browser. Tree, commits, and blobs load from tipped Freenet packs
            on demand — the same data{" "}
            <span className="mono">git clone freenet::…</span> uses.
          </p>
        </article>
        <article className="landing-feature">
          <h2>Find repos on the network</h2>
          <p>
            Curated Freenet mirrors stay easy to open. Repos you register on
            ForgeRegistry show up for everyone. Stars are signed on Freenet
            (ForgeStars), not a private server scoreboard.
          </p>
        </article>
        <article className="landing-feature">
          <h2>Own the forge surface</h2>
          <p>
            Create repos from the header +, push with freenet-git, optionally
            enable Hub Pages. Identity, signing, and listings stay under your
            node’s keys.
          </p>
        </article>
      </section>

      <section className="landing-repos panel">
        <h2>Repos on Freenet</h2>
        <p className="lede">
          Public mirrors you can open in {brand.displayName} right away (same{" "}
          <span className="mono">freenet::</span> addresses you clone from a
          terminal).
        </p>
        <ul className="repo-cards landing-repo-cards">
          {EMBEDDED_DEMOS.map((repo) => {
            const parsed = hubPathFromUrl(repo.url);
            if (!parsed) return null;
            return (
              <li key={repo.url}>
                <Link
                  to={repoHref(parsed.prefix, parsed.label)}
                  className="repo-card"
                >
                  <strong>{repo.name}</strong>
                  <span className="muted">{repo.description}</span>
                  <span className="mono">
                    {repoPathDisplay(parsed.prefix, parsed.label)}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
        <p className="muted tiny">
          After you sign in, the logo opens the home page — curated repos plus
          everything on {registryLabel()}.
        </p>
      </section>
    </main>
  );
}

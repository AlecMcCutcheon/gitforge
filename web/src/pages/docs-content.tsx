/**
 * GitForge docs content — every section of the in-app wiki.
 *
 * Plain JSX (no markdown pipeline) so the docs page has its own typography and
 * can link to real app routes via spa-link. Keep section `slug` stable: it is
 * the `/docs/:slug` path segment.
 */
import type { ReactNode } from "react";
import { Link } from "../spa-link";

export type DocsStatus = "yes" | "partial" | "soon" | "no";

export interface DocsSection {
  slug: string;
  group: string;
  nav: string;
  title: string;
  blurb: string;
  body: ReactNode;
}

/* ------------------------------------------------------------------ *
 * Small doc helpers
 * ------------------------------------------------------------------ */

function Code({ children }: { children: ReactNode }) {
  return <code className="docs-code">{children}</code>;
}

function Pre({
  title,
  children,
}: {
  title?: string;
  children: ReactNode;
}) {
  return (
    <div className="docs-pre">
      {title ? <div className="docs-pre-title">{title}</div> : null}
      <pre>
        <code>{children}</code>
      </pre>
    </div>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <div className="docs-note">{children}</div>;
}

function Tip({ children }: { children: ReactNode }) {
  return <div className="docs-note docs-note--tip">{children}</div>;
}

function Warn({ children }: { children: ReactNode }) {
  return <div className="docs-note docs-note--warn">{children}</div>;
}

function Status({ kind }: { kind: DocsStatus }) {
  const label =
    kind === "yes"
      ? "Works today"
      : kind === "partial"
        ? "Partial"
        : kind === "soon"
          ? "Planned"
          : "Not yet";
  return (
    <span className={`docs-status docs-status--${kind}`}>{label}</span>
  );
}

function Table({
  head,
  rows,
}: {
  head: ReactNode[];
  rows: ReactNode[][];
}) {
  return (
    <div className="docs-table-wrap">
      <table className="docs-table">
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Card({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="docs-card">
      <h4>{title}</h4>
      <p>{children}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Sections
 * ------------------------------------------------------------------ */

const overview: DocsSection = {
  slug: "overview",
  group: "Get started",
  nav: "Overview",
  title: "Welcome to GitForge",
  blurb:
    "A forge for git hosted on Freenet — browse, publish, and collaborate without a central GitHub-style server.",
  body: (
    <>
      <p>
        GitForge is the user interface (and the Hub contracts behind it) that
        make <strong>freenet-git</strong> repositories usable day to day.
        Repositories live as Freenet contracts, discoverable and reachable by
        anyone on the network — there is no central server that can be shut
        down, bought, or pointed at you.
      </p>

      <h2>Why it exists</h2>
      <p>GitForge exists to give git a home on Freenet without recreating GitHub:</p>
      <ul>
        <li>
          <strong>Decentralized forge UX</strong> — Discover, profiles, stars,
          settings, and tip-pack code browsing run against your local Freenet
          node. The real surface is a published Freenet website contract, not a
          local dev server.
        </li>
        <li>
          <strong>Identity you own</strong> — Create / restore / download a
          freenet-git identity bundle. ForgeVault and profile helpers ride with
          that identity; they are not a lock-in account.
        </li>
        <li>
          <strong>Browse without a clone</strong> — Repositories are stored as
          "tip packs" on the network. GitForge streams and decodes the packs
          your node already has, so the Code tab works without downloading a
          full clone.
        </li>
      </ul>

      <h2>Key concepts</h2>
      <div className="docs-cards">
        <Card title="freenet-git repos">
          Repositories are git histories published to Freenet as contracts.
          You push with <Code>git-remote-freenet</Code> / <Code>freenet-git</Code>.
        </Card>
        <Card title="Identity bundle">
          Your credential: a downloaded <Code>.bundle</Code> file plus a
          recovery phrase. Restore it anywhere to get your identity back.
        </Card>
        <Card title="ForgeVault">
          Sealed settings, repo keys, and API keys that sync with your
          identity, so a node sandbox wipe does not erase your vault index.
        </Card>
        <Card title="Tip-pack browse">
          Code, commits, branches, and tags are decoded from tipped packs over
          your node's WebSocket — no full clone required.
        </Card>
        <Card title="Hub contracts">
          ForgeRegistry (Discover), ForgeStars (stars), ForgeRepo (metadata),
          ForgeVault (secrets), and forge-identity / forge-pages delegates.
        </Card>
        <Card title="Website contract">
          The GitForge SPA itself is published as a Freenet website contract —
          the same mechanism GitForge Pages uses for your own sites.
        </Card>
      </div>

      <Note>
        <strong>Cold contracts are real.</strong> Freenet nodes keep contracts
        warm under demand; if nothing on <em>your</em> node is retaining a tip
        pack, it can go cold and code browsing will report it. Keep important
        work reachable from        a node you trust (use it, or pin it — see{" "}
        <Link to="/docs/protect">Pin &amp; local protect</Link>).
      </Note>
    </>
  ),
};

const quickstart: DocsSection = {
  slug: "quickstart",
  group: "Get started",
  nav: "Quick start",
  title: "Quick start",
  blurb: "From zero to browsing and publishing a repository in a few minutes.",
  body: (
    <>
      <h2>1 · Run a Freenet node</h2>
      <p>
        GitForge talks to a local Freenet node over WebSocket. Start your node
        (e.g. <Code>systemctl --user start freenet</Code>) and make sure{" "}
        <Code>fdev</Code> is on your PATH.
      </p>

      <h2>2 · Create your identity</h2>
      <p>
        Open GitForge and click <strong>Create</strong> in the top-right corner.
        You'll get:
      </p>
      <ul>
        <li>A <strong>recovery phrase</strong> — write it down.</li>
        <li>A downloadable <strong>identity bundle</strong> — keep it safe.</li>
        <li>
          A fingerprint (shown as friendly words) that is your public handle on
          the network.
        </li>
      </ul>
      <p>
        Lost your identity? Use <strong>Restore</strong> with the bundle or
        phrase. It works from any node.
      </p>

      <h2>3 · Look around</h2>
      <p>
        Signed in, the home page becomes <strong>Discover</strong>: a list of
        seed demos (freenet-stdlib, freenet-git, freenet-core) plus any repos
        registered on the ForgeRegistry. Click into one and use the Code /
        Commits / Branches / Tags tabs — no clone needed.
      </p>

      <h2>4 · Create or import a repository</h2>
      <ul>
        <li>
          <strong>New repository</strong> — the <Code>+</Code> menu in the
          header creates an empty repo and scaffolds starter files.
        </li>
        <li>
          <strong>Import</strong> — point GitForge at an existing freenet-git
          repo (e.g. <Code>freenet::&lt;prefix&gt;/&lt;name&gt;</Code>) to
          register it on the registry.
        </li>
        <li>
          <strong>Register</strong> — give your repo a public label and
          description so it shows up in Discover.
        </li>
      </ul>

      <h2>5 · Push with git</h2>
      <p>
        Install <Code>freenet-git</Code> / <Code>git-remote-freenet</Code>, then
        use git as usual:
      </p>
      <Pre title="terminal">
        {`git remote add freenet freenet::<your-prefix>/<repo-name>
git push freenet main`}
      </Pre>
      <p>
        Your commits publish as tip packs. Anyone browsing the repo on GitForge
        sees them without a full clone.
      </p>

      <h2>6 · Try the CLI (optional)</h2>
      <p>
        From the repo root, <Code>npm run install:cli</Code> links the{" "}
        <Code>gitforge</Code> CLI for vault / repo / pages operations — see the{" "}
        <Link to="/docs/cli">CLI reference</Link>.
      </p>

      <Tip>
        <strong>Back up early.</strong> Download your identity bundle and store
        the recovery phrase before you start registering repositories — it is
        the only way back in after a node wipe.
      </Tip>
    </>
  ),
};

const identity: DocsSection = {
  slug: "identity",
  group: "Features",
  nav: "Identity & vault",
  title: "Identity & ForgeVault",
  blurb:
    "Your identity is a bundle you own — not an account a server can take away.",
  body: (
    <>
      <h2>The identity bundle</h2>
      <p>
        GitForge uses the <strong>forge-identity</strong> delegate to hold your
        freenet-git identity. Creating an identity gives you:
      </p>
      <ul>
        <li>
          <strong>Recovery phrase</strong> — 12 words that can regenerate the
          identity from anywhere.
        </li>
        <li>
          <strong>Identity bundle</strong> — a downloadable file
          (<Code>.bundle</Code>) you can keep offline and re-import.
        </li>
        <li>
          <strong>Fingerprint</strong> — your public identifier, rendered as
          friendly words in the UI.
        </li>
      </ul>
      <p>
        Sign-out clears the local session only. Restore (bundle or phrase) on
        any node reattaches the same identity — including your vault state if it
        is still on the network.
      </p>

      <h2>ForgeVault</h2>
      <p>
        ForgeVault is a sealed storage contract that rides with your identity.
        It holds:
      </p>
      <ul>
        <li>Repo keys and settings envelopes</li>
        <li>Minted API keys (repo / pages / settings scopes)</li>
        <li>Pages website signing keys</li>
      </ul>
      <p>
        The vault is encrypted — ciphertext is public on the contract, but the
        decryption key is wrapped by your identity, so only you can open it.
        <strong>Settings → Sync</strong> pushes or pulls your vault between this
        node and the network.
      </p>

      <h2>API keys</h2>
      <p>
        <strong>Settings → API keys</strong> lets you mint scoped keys for CLI
        automation. Scopes are envelopes: <Code>repos</Code> (repo-key sync),{" "}
        <Code>pages</Code> (Pages signing keys), and <Code>settings</Code>{" "}
        (settings prefs). Registry operations (register / about / rename) need
        the identity bundle instead — see the{" "}
        <Link to="/docs/cli">CLI reference</Link>.
      </p>

      <h2>Downloads</h2>
      <p>
        <strong>Settings → Downloads</strong> re-exports your identity bundle,
        recovery phrase, and related artifacts — useful when moving to a new
        machine.
      </p>

      <Warn>
        <strong>There is no account recovery service.</strong> If you lose the
        bundle <em>and</em> the phrase, the identity is gone for good. Store
        both somewhere safe (password manager, offline backup).
      </Warn>
    </>
  ),
};

const repositories: DocsSection = {
  slug: "repositories",
  group: "Features",
  nav: "Repositories",
  title: "Repositories",
  blurb:
    "Create, import, register, and manage freenet-git repositories on the registry.",
  body: (
    <>
      <h2>Create & import</h2>
      <ul>
        <li>
          <strong>New repository</strong> — creates an empty repo and offers
          starter files (README, LICENSE, .gitignore) so it is browseable
          immediately.
        </li>
        <li>
          <strong>Import</strong> — bring an existing freenet-git repo onto the
          registry by its <Code>freenet::&lt;prefix&gt;/&lt;name&gt;</Code>{" "}
          address.
        </li>
      </ul>

      <h2>Register & metadata</h2>
      <p>
        Registration publishes a ForgeRegistry listing for your repo:{" "}
        <strong>label</strong>, <strong>description</strong>, and optional{" "}
        <strong>website</strong>. Registered repos appear in Discover and get
        the full repo header (About, health, stars, pages). You can edit the
        About info anytime.
      </p>

      <h2>Rename</h2>
      <p>
        <strong>Settings → General</strong> renames the repo's display name.
        Renaming signs <Code>RepoState.name</Code> on the Freenet repo
        contract — the contract key (prefix) stays fixed, only the label in
        URLs changes. Renaming is a normal, reversible action; it lives in
        General, not the Danger Zone.
      </p>

      <h2>Danger Zone</h2>
      <p>
        Two actions are destructive and registry-owner-only:
      </p>
      <ul>
        <li>
          <strong>Unregister</strong> — clears the ForgeRegistry listing so
          the repo leaves Discover and People. The Freenet repo contract and
          your local identity key are kept — use Import to list it again. If
          Pages is enabled, the website is taken down first.
        </li>
        <li>
          <strong>Soft delete</strong> — marks the freenet-git contract
          abandoned and removes the listing. Freenet cannot wipe historical
          packs from every peer. If Pages is enabled, take-down runs first,
          and there is no going back.
        </li>
      </ul>

      <h2>Repo health</h2>
      <p>
        The repo header shows a <strong>health block</strong>: whether the
        registry listing is reachable and whether tip packs are available on
        the network. It surfaces rescue paths (e.g. republish or retain packs)
        when something has gone cold — it cannot invent bytes your local node
        already evicted.
      </p>

      <h2>Your work</h2>
      <p>
        The <strong>Your work</strong> view lists the repos tied to your
        identity: what you created, imported, or were invited to, with quick
        actions like Pages and Downloads per row.
      </p>

      <h2>Collaboration</h2>
      <p>
        Repos are not locked to one owner. Use the{" "}
        <Link to="/docs/inbox">Inbox</Link> to accept repo invites from other
        identities, and anyone can browse a public repo by its prefix.
      </p>

      <Tip>
        After creating a repo, register it (About → Register) — unregistered
        repos exist on the network but won't show up in Discover.
      </Tip>
    </>
  ),
};

const browsing: DocsSection = {
  slug: "browsing",
  group: "Features",
  nav: "Browsing & code",
  title: "Browsing & code",
  blurb:
    "Tip-pack browsing: read code, history, branches, and tags without cloning anything.",
  body: (
    <>
      <h2>How tip-pack browse works</h2>
      <p>
        GitForge does not clone repositories. Instead it reads the{" "}
        <strong>tip packs</strong> your node already has on the network,
        streams them over the node WebSocket, and decodes them in the browser
        (IndexedDB + wasm). That means:
      </p>
      <ul>
        <li>Instant Code / Commits / Branches / Tags views</li>
        <li>No central server involved in serving file contents</li>
        <li>
          Legacy untipped repos may not be browseable until tip metadata exists
          — the Code tab will tell you rather than attempting a full clone.
        </li>
      </ul>

      <h2>Code view</h2>
      <ul>
        <li>File tree + file preview with syntax highlighting</li>
        <li>README rendered as GitHub-flavored markdown (with badge support)</li>
        <li>Preview / Code / Blame modes on markdown and code files</li>
        <li>Edit & push files straight from the browser when you own the repo</li>
      </ul>

      <h2>Commits, branches & tags</h2>
      <ul>
        <li>
          <strong>Commits</strong> — full history with branch divergence
          banners when your branch has drifted from a tracked upstream.
        </li>
        <li>
          <strong>Branches</strong> — list and switch the branch you're
          viewing.
        </li>
        <li>
          <strong>Tags</strong> — named releases at a glance.
        </li>
      </ul>

      <h2>Languages & license</h2>
      <p>
        A linguist-style sidebar shows the language breakdown of the tip
        tree, and a <strong>license detection</strong> helper (freenet-licensee)
        identifies the LICENSE file. Both are computed from the tip blobs — no
        GitHub-style server-side scans.
      </p>

      <h2>Raw entries</h2>
      <p>
        Raw files can be fetched by path (with <Code>?raw=</Code> on the
        website root, or the in-app raw view) — handy for curl-ing a single
        file off the network.
      </p>

      <Note>
        Markdown rendering is deliberately sandboxed (rehype-sanitize) and
        shields.io badges are re-rendered locally, because the SPA runs inside
        Freenet's iframe CSP.
      </Note>

      <Tip>
        Digging into failures like <Code>commit … not in tip pack</Code>? See{" "}
        <Link to="/docs/tip-packs">Tip packs</Link> for how packs work, why
        Rescue is not enough, and the snapshot republish playbook.
      </Tip>
    </>
  ),
};

const tipPacks: DocsSection = {
  slug: "tip-packs",
  group: "Features",
  nav: "Tip packs",
  title: "Tip packs",
  blurb:
    "How Freenet tip packs work, why “not in tip pack” happens, and how to fix it.",
  body: (
    <>
      <h2>What a tip pack is</h2>
      <p>
        A Freenet git repo is two layers: a signed <strong>RepoState</strong>{" "}
        contract (refs, tipped-bundle index, mirror mode) and one or more{" "}
        <strong>tip pack</strong> contracts (content-addressed git pack bytes —
        single or chunked). GitForge never full-clones for browse: it GETs
        RepoState, loads tip packs over your node, soft-fills older tipped
        packs into memory, and walks trees in wasm.
      </p>
      <Table
        head={["Piece", "Job"]}
        rows={[
          [
            "Repo contract",
            "Refs (e.g. main → commit hex), tipped-bundle list, metadata",
          ],
          [
            "Tip pack",
            "Git objects for a tip commit — whatever that push actually included",
          ],
          [
            "Soft-fill",
            "After HEAD tip loads, merge other tipped packs so nested trees / history appear",
          ],
          [
            "Pin / Protect",
            "Keep the live tip-graph packs warm on your node (not “newest by age” only)",
          ],
        ]}
      />

      <h2>History vs snapshot</h2>
      <p>
        Push mirror mode is set with <Code>FREENET_GIT_MIRROR_MODE</Code>:
      </p>
      <ul>
        <li>
          <strong>history</strong> — incremental tips. A new tip may assume
          older tipped packs still hold ancestor objects. Soft-fill and pin
          “current” keep the whole live tip closure.
        </li>
        <li>
          <strong>snapshot</strong> — self-contained tip pack (full tree
          closure). Browse can work from one pack; older tipped bundles are
          often dead weight.
        </li>
      </ul>
      <Warn>
        An “empty” republish tip of a few hundred bytes is almost always a thin
        delta without the tree. That looks like a successful push and still
        leaves <Code>missing tree …</Code> on Freenet.
      </Warn>

      <h2>Errors you will see</h2>
      <Table
        head={["Message", "Meaning"]}
        rows={[
          [
            <Code>commit … not in tip pack</Code>,
            "RepoState ref points at a commit whose objects are not in any loaded tip pack",
          ],
          [
            <Code>missing tree …</Code>,
            "Commit may be present but the root/subdir tree lives only in a pack that never published or never soft-filled",
          ],
          [
            "Packs reachable N/N · Rescue OK",
            "Contracts soft-GET fine — does not prove the object graph is complete",
          ],
        ]}
      />

      <h2>Why Rescue often “does nothing”</h2>
      <p>
        <strong>Rescue re-PUTs packs that already exist</strong> (IDB, backup,
        network, or <Code>freenet-git rescue --from</Code> reconstruction of{" "}
        <em>listed</em> bundle IDs). It cannot invent a tip that was never
        published. Classic trap:
      </p>
      <ol>
        <li>Freenet <Code>main</Code> still points at commit <Code>b676cee…</Code></li>
        <li>Local / GitHub already moved on, or that tip’s pack was thin / incomplete</li>
        <li>Rescue reports rescued bundles / health shows Low need</li>
        <li>Browse still throws <Code>not in tip pack</Code></li>
      </ol>
      <Note>
        Repo health “Packs reachable” answers “can I fetch these pack
        contracts?” — not “does the tip contain every object needed to walk the
        tree?”
      </Note>

      <h2>Fix playbook (owner)</h2>
      <p>
        On a machine with the identity bundle, passphrase, Freenet node, and a
        local clone that has the missing oid (<Code>git cat-file -t …</Code>):
      </p>
      <Pre title="1. Confirm mismatch">
        {`git ls-remote freenet HEAD
git rev-parse HEAD
git cat-file -t <missing-oid>`}
      </Pre>
      <Pre title="2. Snapshot republish (reliable browse restore)">
        {`export FREENET_GIT_IDENTITY=…   # path to identity bundle
export FREENET_GIT_PASSPHRASE=…  # quote if it has spaces
export FREENET_GIT_MIRROR_MODE=snapshot

TREE=$(git rev-parse 'HEAD^{tree}')
ORPHAN=$(git commit-tree "$TREE" -m "chore: snapshot republish tip onto Freenet")

git push --force freenet "$ORPHAN:refs/heads/main"
freenet-git rescue --only-current-tips --from . 'freenet::<prefix>/<label>'`}
      </Pre>
      <ul>
        <li>
          Local / GitHub <Code>main</Code> stay on real history; only the
          Freenet tip becomes the orphan (same tree → same files).
        </li>
        <li>
          Expect a <strong>large</strong> pack (hundreds of KiB+), not ~200 B.
        </li>
        <li>Hard-refresh GitForge after rescue.</li>
      </ul>
      <Pre title="What not to rely on alone">
        {`# Only re-PUTs known tipped bundles
freenet-git rescue --rescue-all 'freenet::<prefix>/<label>'

# Empty history tip is often thin — tree never lands
git commit --allow-empty -m "republish"
git push freenet main`}
      </Pre>

      <h2>After it works</h2>
      <p>
        Later pushes with <Code>FREENET_GIT_MIRROR_MODE=history</Code> can grow
        a tipped soft-fill chain again. Pin{" "}
        <strong>Current tip packs (live tip graph)</strong> keeps every pack
        still needed for soft-fill — not only the chronologically newest tip.
        Bare CLI <Code>git push freenet</Code> does not auto-pin; leave the
        repo open in GitForge (ProtectWorker) or hit Sync after CLI pushes.
      </p>

      <Tip>
        Longer operator notes also live in the repo at{" "}
        <Code>docs/17-tip-packs.md</Code> (WS/chunk transport:{" "}
        <Code>docs/15-freenet-git-ws-hygiene.md</Code>).
      </Tip>
    </>
  ),
};

const discover: DocsSection = {
  slug: "discover",
  group: "Features",
  nav: "Discover, people & stars",
  title: "Discover, people & stars",
  blurb: "Find repositories, explore identities, and bookmark what you like.",
  body: (
    <>
      <h2>Discover</h2>
      <p>
        Signed in, the home page is <strong>Discover</strong>: curated seed
        demos plus every repository registered on the ForgeRegistry. It is the
        Freenet-native equivalent of GitHub's Explore.
      </p>

      <h2>People</h2>
      <p>
        Every identity has a public profile page (reachable via your avatar or
        a fingerprint link) with three tabs:
      </p>
      <ul>
        <li><strong>Overview</strong> — avatar, status, and bio</li>
        <li><strong>Repositories</strong> — public repos the identity owns</li>
        <li><strong>Stars</strong> — repos they've starred</li>
      </ul>

      <h2>Stars</h2>
      <p>
        The <strong>ForgeStars</strong> contract powers star / unstar on any
        repo. Your stars live with your identity, so they follow you across
        nodes — and the profile Stars tab shows them publicly.
      </p>

      <h2>Status</h2>
      <p>
        Set a status emoji + text from your account menu; it shows on your
        profile and to people who visit it.
      </p>
    </>
  ),
};

const inbox: DocsSection = {
  slug: "inbox",
  group: "Features",
  nav: "Inbox",
  title: "Inbox",
  blurb: "Encrypted, identity-to-identity messages — system notices and repo invites.",
  body: (
    <>
      <h2>What the Inbox is for</h2>
      <p>
        The Inbox is a per-identity message box on the network, encrypted so
        only the recipient can read it. It carries:
      </p>
      <ul>
        <li>
          <strong>Repo invites</strong> — another identity can invite you to a
          repository; you accept or deny from the Inbox.
        </li>
        <li>
          <strong>System notices</strong> — GitForge/network-level messages.
        </li>
      </ul>
      <p>
        Messages are tied to your identity (not a device), so restoring your
        bundle elsewhere brings the Inbox with you. The bell icon in the header
        opens it; read items move to <strong>Done</strong>.
      </p>

      <h2>Why it exists</h2>
      <p>
        On GitHub, "notifications" and "collaboration requests" come from a
        central service. On Freenet there is no service — so GitForge defines an
        encrypted, decentralized inbox contract that identities can write to
        directly.
      </p>
    </>
  ),
};

const pages: DocsSection = {
  slug: "pages",
  group: "Features",
  nav: "GitForge Pages",
  title: "GitForge Pages",
  blurb: "Deploy a Freenet website contract straight from a repo's tip branch.",
  body: (
    <>
      <h2>What it is</h2>
      <p>
        GitForge Pages deploys a <strong>Freenet website contract</strong> from
        a branch of your repo — the decentralized analogue of GitHub Pages. The
        branch (or a subdirectory via <Code>rootPath</Code>) must contain an{" "}
        <Code>index.html</Code>; everything is served as a static Freenet
        website.
      </p>

      <h2>How it works</h2>
      <ol>
        <li>
          <strong>Enable</strong> (registry owner) — the SPA extracts the tip,
          builds a ustar archive, and publishes it as a website contract signed
          by the <strong>forge-pages</strong> delegate.
        </li>
        <li>
          <strong>Sync</strong> — when your tip moves to a new commit, Sync
          republishes the website. <strong>autoSync</strong> (default on) does
          this when you open the Code tab as the owner.
        </li>
        <li>
          <strong>Disable</strong> — clears the Pages metadata and optionally
          writes a tombstone page.
        </li>
      </ol>
      <p>
        When enabled, the UI shows the site's <strong>contract key</strong> and
        an <strong>Open site</strong> link. Visitors can open the site without
        any registry access — the public <Code>pages</Code> metadata on the
        repo is enough.
      </p>

      <h2>Gates</h2>
      <p>
        Enabling / syncing / disabling requires all of: a signed-in identity,
        the repo's site key on that identity, and a live registry listing owned
        by that same fingerprint. Unregister and soft-delete always take the
        Pages site down first — you can't leave a live site behind a deleted
        listing.
      </p>

      <h2>CLI</h2>
      <p>
        The same flows are available as <Code>gitforge pages</Code> subcommands
        (create / update / disable / url / status) using your identity bundle —
        see the <Link to="/docs/cli">CLI reference</Link>.
      </p>

      <Note>
        No Actions or CI: Pages publishes the static tip tree only. Build
        artifacts must be committed to the branch you publish.
      </Note>
    </>
  ),
};

const protect: DocsSection = {
  slug: "protect",
  group: "Features",
  nav: "Pin & local protect",
  title: "Pin & local protect",
  blurb: "Keep the contracts you care about warm on your node.",
  body: (
    <>
      <h2>Why protect?</h2>
      <p>
        Freenet keeps contracts warm under demand. If nothing on your node is
        retaining a contract, it can go cold — and a cold repo is unreadable
        until someone republishes it. <strong>Pin / local protect</strong> asks
        your node to retain specific contracts locally so they don't vanish.
      </p>

      <h2>Identity-level protect</h2>
      <p>
        <strong>Settings → Pin</strong> (when your node supports local contract
        protect) manages grants for your identity areas:
      </p>
      <ul>
        <li><Code>gitforge:identity:profile</Code> — your public profile</li>
        <li><Code>gitforge:identity:vault</Code> — your ForgeVault</li>
        <li><Code>gitforge:identity:website</Code> — website contracts</li>
      </ul>

      <h2>Repo-level protect</h2>
      <p>
        Each repo you care about gets a <Code>gitforge:repo:&lt;prefix&gt;</Code>{" "}
        grant. The repo settings page shows protect controls plus a{" "}
        <strong>backup</strong> block: pinning repo packs and rehydrating
        backup blobs so your work survives eviction elsewhere.
      </p>

      <h2>The experimental pin patch</h2>
      <p>
        Local contract pinning is powered by an <strong>experimental,
        unofficial patch</strong> to Freenet core —{" "}
        <a
          href="https://github.com/AlecMcCutcheon/freenet-core/tree/local-contract-pin"
          target="_blank"
          rel="noreferrer"
        >
          AlecMcCutcheon/freenet-core — local-contract-pin
        </a>
        . It is not part of upstream freenet-core yet. If your node isn't
        running a build with that patch, the protect controls say pinning
        isn't supported rather than pretending it worked.
      </p>

      <Warn>
        Protect can't resurrect bytes that were already evicted before you
        pinned them. Pin early — especially anything you've pushed but not
        mirrored elsewhere. If browse says <Code>not in tip pack</Code> but
        Rescue looks fine, see <Link to="/docs/tip-packs">Tip packs</Link> —
        you likely need a snapshot republish, not another rescue.
      </Warn>
    </>
  ),
};

const publicGoods: DocsSection = {
  slug: "public-goods",
  group: "Features",
  nav: "Public goods",
  title: "Public goods",
  blurb: "Opt-in contributions from GitForge to the Freenet public goods network.",
  body: (
    <>
      <h2>What "public goods" means here</h2>
      <p>
        Several Freenet services (time, randomness, search…) are community-run
        "public goods": they work because browsers contribute a little
        computation while they're open. GitForge runs a{" "}
        <strong>duty worker</strong> in website mode that can contribute to
        these services — delayed and non-blocking, so it never slows down first
        paint or page interactions.
      </p>

      <h2>Which services</h2>
      <ul>
        <li>
          <strong>Kairos (verifiable time)</strong> — the worker soft-Gets,
          subscribes, and submits time pulses / observe stamps.
        </li>
        <li>
          <strong>Tyche (randomness)</strong> — contribution through the same
          delayed-duty worker pattern.
        </li>
      </ul>

      <h2>Your control</h2>
      <p>
        <strong>Settings → Public goods</strong> lists services you've imported
        from site goodwill manifests. Each service runs under{" "}
        <em>its own delegate identity</em>, and you can toggle{" "}
        <strong>Contribute automatically</strong> per service. Nothing
        contributes until you enable it.
      </p>

      <h2>Why it exists</h2>
      <p>
        GitForge is a network citizen: the same decentralized infrastructure
        that hosts your repos depends on the ecosystem staying alive. Opt-in,
        per-service contribution is a low-cost way to give back without
        handing over control.
      </p>
    </>
  ),
};

const cli: DocsSection = {
  slug: "cli",
  group: "CLI",
  nav: "CLI reference",
  title: "GitForge CLI",
  blurb:
    "gitforge — one command for vault, repo, and Pages operations, in the same spirit as freenet-git.",
  body: (
    <>
      <h2>Why a CLI?</h2>
      <p>
        The web app covers everyday browsing, but scripted workflows (sync your
        vault, register a repo from CI, flip Pages on for a release) need
        something callable. <Code>gitforge</Code> is a single TypeScript entry
        point — <Code>npm</Code> + <Code>tsx</Code> — that reuses the exact
        vault/crypto modules the web app uses, so CLI and browser never drift.
      </p>

      <h2>Install</h2>
      <p>From the freenet-gitforge repo root:</p>
      <Pre title="terminal">
        {`npm run install:cli        # npm link → gitforge on PATH
# or run without linking:
npm run gitforge -- help`}
      </Pre>
      <p>
        Requires Node and a reachable Freenet node for any Freenet operation.
      </p>

      <h2>Command groups</h2>
      <Table
        head={["Group", "Subcommands", "Credential", "What it does"]}
        rows={[
          [
            <Code>gitforge vault</Code>,
            <Code>sync-bundle · pull-bundle</Code>,
            "API key (repos scope)",
            "Sync your ForgeVault envelope with an identity bundle — push or pull sealed repo keys.",
          ],
          [
            <Code>gitforge repo</Code>,
            <Code>about · register · unregister · rename · delete</Code>,
            "Identity bundle",
            "Registry & RepoState operations for a repository prefix.",
          ],
          [
            <Code>gitforge pages</Code>,
            <Code>create · update · disable · url · status</Code>,
            "Identity bundle",
            "Manage a GitForge Pages website deployed from a tip branch.",
          ],
        ]}
      />

      <h2>Vault (API key)</h2>
      <p>
        Mint an API key with the <strong>repos</strong> scope in{" "}
        <strong>Settings → API keys</strong>, then:
      </p>
      <Pre title="terminal">
        {`export GATK="your-minted-key"   # or GITFORGE_API_KEY

gitforge vault sync-bundle \
  --api-key "$GATK" \
  --bundle ~/path/to/git-identity.bundle \
  --bundle-passphrase '…'

gitforge vault pull-bundle \
  --api-key "$GATK" \
  --bundle ~/path/to/git-identity.bundle \
  --bundle-passphrase '…'`}
      </Pre>

      <h2>Repo (identity bundle)</h2>
      <p>
        Registry ops need the identity bundle (dual-signature), not an API key:
      </p>
      <Pre title="terminal">
        {`gitforge repo about --bundle … --bundle-passphrase '…' \\
  --prefix 7FMQGtHpkidg --label gitforge \\
  --description 'Git forge for Freenet — tip-pack browse without a central server.'

gitforge repo register   --bundle … --prefix … --label …
gitforge repo unregister --bundle … --prefix …
gitforge repo rename     --bundle … --prefix … --name NewName
gitforge repo delete     --bundle … --prefix …`}
      </Pre>

      <h2>Pages (identity bundle)</h2>
      <Pre title="terminal">
        {`gitforge pages create --bundle … --bundle-passphrase '…' \\
  --prefix 6zkX4rgEkxD6 --label pages-test --branch main

gitforge pages update  --bundle … --prefix … --label …
gitforge pages disable --bundle … --prefix … --label …
gitforge pages url     --bundle … --prefix … --label …
gitforge pages status  --bundle … --prefix … --label …`}
      </Pre>
      <p>
        <Code>create</Code> enables Pages (Put website from tip);{" "}
        <Code>update</Code> syncs it. Requires registry ownership and a live
        forge-pages delegate on the node.
      </p>

      <h2>API key scopes</h2>
      <Table
        head={["Scope", "Envelope"]}
        rows={[
          [<Code>repos</Code>, "Repo keys (CLI vault sync)"],
          [<Code>pages</Code>, "Pages website signing keys"],
          [<Code>settings</Code>, "Settings / Protect prefs"],
        ]}
      />

      <h2>Environment</h2>
      <Table
        head={["Variable", "Default", "Meaning"]}
        rows={[
          [
            <>
              <Code>GITFORGE_API_KEY</Code> / <Code>GATK</Code>
            </>,
            "—",
            "API key for vault commands (first wins)",
          ],
          [
            <Code>FREENET_WS_URL</Code>,
            <Code>ws://127.0.0.1:7509/v1/contract/command</Code>,
            "Node WebSocket endpoint",
          ],
        ]}
      />

      <h2>freenet-git & git-remote-freenet</h2>
      <p>
        <Code>gitforge</Code> manages registry/vault/Pages metadata. The actual
        git push/pull plumbing is <strong>freenet-git</strong> (a Cargo binary
        with clap subcommands) and its <Code>git-remote-freenet</Code> helper:
      </p>
      <Pre title="terminal">
        {`git remote add freenet freenet::<prefix>/<repo>
git push freenet main
git clone freenet::<prefix>/<repo>`}
      </Pre>

      <Note>
        <Code>gitatlas</Code> is a deprecated shim that forwards to{" "}
        <Code>gitforge</Code>. Prefer <Code>gitforge</Code>.
      </Note>
    </>
  ),
};

const parity: DocsSection = {
  slug: "parity",
  group: "Compare",
  nav: "GitHub parity",
  title: "GitHub parity",
  blurb:
    "Feature by feature: what GitForge has today, what's partial, and what isn't there yet.",
  body: (
    <>
      <p>
        GitForge is not trying to clone GitHub — it's a forge built on a
        different substrate (contracts, not servers). Still, if you're coming
        from GitHub, this table is the fastest way to map what you know:
      </p>

      <Table
        head={["GitHub", "GitForge", "Status"]}
        rows={[
          ["Repository code browsing (files, tree)", "Tip-pack Code view", <Status kind="yes" />],
          ["Commit history", "Commits view (with divergence banners)", <Status kind="yes" />],
          ["Branches", "Branches view", <Status kind="yes" />],
          ["Tags", "Tags view", <Status kind="yes" />],
          ["README rendering", "GFM markdown preview (sanitized)", <Status kind="yes" />],
          ["Raw file access", "Raw entries (?raw= / raw view)", <Status kind="yes" />],
          ["Starring", "ForgeStars — star/unstar, profile Stars tab", <Status kind="yes" />],
          ["User profiles", "People pages (Overview / Repos / Stars)", <Status kind="yes" />],
          ["GitHub Pages", "GitForge Pages (Freenet website contract from tip)", <Status kind="yes" />],
          ["GitHub CLI", "gitforge CLI (vault / repo / pages)", <Status kind="yes" />],
          ["Personal access tokens", "Scoped API keys (repos / pages / settings)", <Status kind="yes" />],
          ["Language statistics", "Linguist-style sidebar over tip blobs", <Status kind="yes" />],
          ["License detection", "freenet-licensee LICENSE detection", <Status kind="yes" />],
          ["Notifications", "Encrypted identity Inbox (system + invites)", <Status kind="partial" />],
          ["Soft delete / restore", "Danger Zone soft-delete + rescue paths", <Status kind="partial" />],
          ["Search", "Discover registry listing", <Status kind="partial" />],
          ["Forking", "Fork placeholder (not shipped)", <Status kind="soon" />],
          ["Issues", "Not yet", <Status kind="no" />],
          ["Pull requests", "Not yet", <Status kind="no" />],
          ["Code review", "Not yet", <Status kind="no" />],
          ["Actions / CI", "Not yet (future releases)", <Status kind="no" />],
          ["Releases", "Removed (placeholder UI retired)", <Status kind="no" />],
          ["Organizations / teams", "N/A — identity-first model", <Status kind="no" />],
        ]}
      />

      <h2>Things GitHub doesn't have</h2>
      <p>Some of the most interesting GitForge features have no GitHub equivalent:</p>
      <ul>
        <li>
          <strong>Tip-pack browse</strong> — read a repo's code and history
          without cloning, straight off the network.
        </li>
        <li>
          <strong>Repo health block</strong> — explicit pack / registry
          reachability with rescue paths instead of silent 404s.
        </li>
        <li>
          <strong>Pin & local protect</strong> — retain contracts on your node
          so they don't go cold.
        </li>
        <li>
          <strong>Identity bundle + recovery phrase</strong> — your forge
          account is a file and 12 words, not a row in a database.
        </li>
        <li>
          <strong>ForgeVault cross-node sync</strong> — sealed keys follow your
          identity, not a server.
        </li>
        <li>
          <strong>Dual-signature CLI</strong> — registry mutations require your
          identity bundle, not just a bearer token.
        </li>
        <li>
          <strong>Public goods duty worker</strong> — the forge gives back to
          the network that hosts it, opt-in per service.
        </li>
      </ul>

      <h2>Why some things are missing</h2>
      <p>
        Issues, PRs, and CI need a notion of "discussion" and "workflow" that
        doesn't exist on the network yet — they're content-addressable problems
        without a central authority to arbitrate them. GitForge deliberately
        ships the read/write core (browse, publish, register, star, Pages)
        first and treats everything else as a future-release decision.
      </p>
    </>
  ),
};

export const DOCS_SECTIONS: DocsSection[] = [
  overview,
  quickstart,
  identity,
  repositories,
  browsing,
  tipPacks,
  discover,
  inbox,
  pages,
  protect,
  publicGoods,
  cli,
  parity,
];

export const docsSectionBySlug: Map<string, DocsSection> = new Map(
  DOCS_SECTIONS.map((s) => [s.slug, s]),
);

export const DOCS_GROUPS: string[] = (() => {
  const seen: string[] = [];
  for (const s of DOCS_SECTIONS) {
    if (!seen.includes(s.group)) seen.push(s.group);
  }
  return seen;
})();

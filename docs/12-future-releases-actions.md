# Future: Releases & Actions-style runners

## Why Releases were removed from GitForge (2026-07)

GitForge briefly showed a GitHub-like **Releases** tab by dressing up `refs/tags/*` (annotated messages + tip-tree zip as “assets”). That is **not** the same as GitHub Releases or a freenet-git release artifact model.

Until freenet-git (and GitForge) have a real release story, GitForge only surfaces **git tags**. There is no `/releases` route (unknown paths 404).

## Later direction (not scheduled)

1. **Release artifacts** — signed, content-addressed assets (not “tag + zip pretending to be a release”), aligned with whatever freenet-git ships in later roadmap phases.
2. **Actions-esque CI** — workflow definitions that can build those artifacts. Ideal: familiar GitHub Actions YAML / `act`-compatible jobs, runnable on **any** Freenet node platform inside a strong sandbox, with results published as Freenet contracts (not tied to one vendor’s runners).

Hard problems to solve before building this: deterministic or attested builds, sandbox escape resistance, job scheduling without a central “Actions farm”, and how peers verify that a release really came from the claimed workflow.

Tune browsing / forge UX first; revisit when the substrate and product priorities are ready.

# Contributing to GitAtlas

We welcome contributions. Reviewer attention is scarce, and code is cheap to
generate — so design discussion happens **before** large PRs.

This policy is intentionally aligned with
[freenet-core’s contributing guide](https://github.com/freenet/freenet-core/blob/main/CONTRIBUTING.md):
ask first for features and behavior changes; ship small, focused PRs.

## What Needs an Issue First

**Accepted without prior discussion:**

- Bug fixes that do not change intended behavior.
- Performance improvements that are not overreaching and do not change behavior.
- Typo fixes, documentation corrections, and obvious one-line changes.

**Requires an approved issue first:**

- **Any feature change or new feature.** Open an issue describing the problem,
  the proposed approach, and important design choices — then wait for a
  maintainer to confirm the approach **before** writing (or landing) the bulk
  of the code. A maintainer explicitly saying “yes, a PR for this is welcome”
  is the green light. **Silence is not approval.**
- **Anything that changes behavior, adds product scope, or reshapes an API**
  (HTTP helpers, Hub contracts, vault/settings schema, identity flows, tip-pack
  browse contracts, publish scripts), even if it started as a bug fix or
  refactor.
- **Anything that depends on freenet-core behavior that is not in upstream
  main** (custom node APIs, forks, experimental retention). Call that out in
  the issue; do not assume reviewers will merge app code that only works on a
  private node fork.

**Feature PRs opened without an approved issue may be closed** until the issue
discussion happens and a maintainer signs off on the approach. Reopening is
welcome after that.

When in doubt, file an issue first. A round-trip is cheaper than throwing away
a PR.

### Scope discipline

- **One logical change per PR.** Do not bundle a feature into a “bug fix,” or
  let a focused change accrete unrelated cleanup.
- **The submitter is responsible for the PR.** Whatever tools produced it, you
  must understand the change well enough to defend design choices, answer
  questions, and revise it. “I’m not sure, the AI wrote it” is grounds for
  closing the PR.
- **Volume is a signal.** A burst of unrelated PRs from a new contributor may
  be treated as one batch and closed pending an issue-level conversation about
  what you actually want to work on.

## Before You Start

- Read [AGENTS.md](AGENTS.md) for layout, conventions, and how we test.
- Skim the relevant notes under [`docs/`](docs/) for Hub contracts, vault, and
  website publish.
- Prefer questions on the issue before writing speculative code.

## Quality Standards

- PR titles follow [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat:`, `fix:`, `docs:`, `chore:`, etc.).
- PR descriptions explain **why**, not only what changed. Link the approved
  issue for features (`Closes #N` / `Refs #N`).
- Prefer reproducing a bug (steps, expected vs actual) before fixing it.
- Keep PRs focused — one logical change.
- Do not commit secrets, local node admin tokens, identity bundles, vault API
  keys, or `.env` files. See `.gitignore`.
- The primary test surface is a **published Freenet website** (`npm run
  publish:website`), not a long-lived local Vite-only loop. Call out how you
  verified the change.

Suggested local checks before pushing (as applicable):

```sh
npm install
npm run build:web          # or publish:website for end-to-end
# Rust / WASM pieces:
cargo fmt
cargo clippy --all-targets
```

## Design Choices We Care About

When opening a feature issue, please address (briefly):

1. **Problem** — who hits it, and what breaks today.
2. **Approach** — intended UX / API shape; alternatives considered.
3. **Freenet shape** — does this assume only demand hosting, vault, delegates,
   tip packs, or something new on the node?
4. **Identity & trust** — node-operator trust vs app hub-identity; never spend
   the user’s node resources from ungated website code.
5. **Data & compatibility** — Hub contract / vault schema changes; migration
   or dual-read plan.
6. **Out of scope** — what this issue deliberately does **not** do.

Maintainer sign-off is on **approach**, not a promise to merge the first PR
draft unchanged.

## AI-Assisted Contributions

AI-assisted work is welcome at the same quality bar as hand-written work.

**Disclose AI assistance** on PRs and substantive review comments — a trailing
line such as `[AI-assisted - Cursor]` or `[AI-assisted - Claude]` is enough.
That is not a barrier; it helps reviewers calibrate.

Please use a capable agentic setup on this codebase (Freenet contracts, crypto,
async WS, tip-pack browse). Plausible-looking PRs that show missing context,
unrelated drive-bys, or hardcoded local paths may be closed.

## Getting Help

- [Issues](https://github.com/AlecMcCutcheon/gitatlas/issues) — bugs and
  feature / design discussion
- [freenet-core contributing](https://github.com/freenet/freenet-core/blob/main/CONTRIBUTING.md)
  — if your change really belongs in the node
- [Freenet Matrix](https://matrix.to/#/#freenet:matrix.org) — wider Freenet
  discussion
- [Freenet manual](https://freenet.org/resources/manual/) — architecture
  overview

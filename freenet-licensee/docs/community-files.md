# Community health / special files (GitAtlas soft support)

GitHub discovers these files for repo UI tabs and community insights.
GitAtlas **soft-supports** the same discovery so we can show tabs when files
exist. We do **not** implement org-wide `.github` inheritance, Advisories,
Discussions, or issue/PR templates.

Reference: [Creating a default community health file](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/creating-a-default-community-health-file).

## Search order

| Kind | Filenames (case-insensitive; `.md` / `.txt` / bare) | Directories (first match wins) |
|------|------------------------------------------------------|--------------------------------|
| README | `README`, `README.md`, … | **repository root only** |
| License | `LICENSE`, `LICENCE`, `COPYING`, `UNLICENSE`, `COPYRIGHT`, `OFL`, … (see licensee scoring) | **repository root only** (not `.github/` or `docs/`) |
| Code of conduct | `CODE_OF_CONDUCT`, `CODE-OF-CONDUCT` | `.github/` → root → `docs/` |
| Contributing | `CONTRIBUTING` | `.github/` → root → `docs/` |
| Security | `SECURITY` | `.github/` → root → `docs/` |

Within a directory, prefer `.md` then bare then `.txt` when multiple variants exist.

License **identity** (MIT vs Apache-2.0, etc.) is detected by `@gitforge/licensee`
content matchers (Copyright → Exact → Dice), not by filename alone.

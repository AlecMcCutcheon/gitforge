# freenet-linguist

TypeScript language detection for GitForge / Freenet tip packs.

Full strategy funnel aligned with [github-linguist/linguist](https://github.com/github-linguist/linguist) `Linguist.detect` / `STRATEGIES`:

1. `.gitattributes` (`linguist-language`, vendored, generated, documentation, detectable)
2. Vendor / documentation / generated / binary filters
3. Modeline → filename → shebang → extension → XML → manpage → heuristics → classifier

The classifier uses **go-enry’s Naive Bayes frequencies** trained on Linguist samples (not Ruby’s in-process centroid trainer — same sample corpus, browser-friendly).

## Package layout

- `src/` — detect / analyze / strategies / tokenizer / heuristics / gitattributes
- `src/generated/` — committed data (`catalog.json`, `heuristics.json`, `aliases.json`, `generic.json`, `classifier.json`, …)
- `_ref/linguist` — optional shallow clone of upstream (gitignored)

## Regenerate catalog data from upstream Linguist

```bash
git clone --depth 1 https://github.com/github-linguist/linguist.git freenet-linguist/_ref/linguist
npm run gen:catalog -w @gitforge/linguist
# when done referencing upstream:
rm -rf freenet-linguist/_ref
```

`classifier.json` is large (~5MB); keep it committed so Vite can code-split it via `ensureClassifier()`.

## Usage

```ts
import { analyzeFilesAsync, parseGitattributes } from "@gitforge/linguist";

const breakdown = await analyzeFilesAsync(
  files.map((f) => ({ path: f.path, size: f.size, content: f.bytes })),
  { gitattributes: parseGitattributes(attrText) },
);
```

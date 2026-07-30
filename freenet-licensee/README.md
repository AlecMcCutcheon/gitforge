# freenet-licensee

TypeScript license detection for GitAtlas — strategies aligned with
[licensee](https://github.com/licensee/licensee) (Copyright → Exact → Dice)
against the choosealicense.com corpus, plus `generateLicense` for create-repo
placeholder fill (`[year]`, `[fullname]`, …).

## Regenerate catalog

```bash
# _ref/licensee should point at a licensee checkout (vendor/choosealicense.com)
npm run gen:catalog -w @gitforge/licensee
```

## Usage

```ts
import {
  detectLicense,
  generateLicense,
  discoverCommunityFiles,
  listLicenses,
} from "@gitforge/licensee";
```

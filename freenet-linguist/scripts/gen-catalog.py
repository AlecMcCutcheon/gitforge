#!/usr/bin/env python3
"""Regenerate freenet-linguist generated data from temporary github-linguist clone.

  git clone --depth 1 https://github.com/github-linguist/linguist.git \\
    freenet-linguist/_ref/linguist
  python3 freenet-linguist/scripts/gen-catalog.py

Classifier frequencies come from go-enry (see scripts/gen-classifier.py if present),
or a one-shot extract from go-enry's data/frequencies.go — keep classifier.json
committed so browsers do not need the Go toolchain.

When the TypeScript implementation is solid, delete freenet-linguist/_ref/.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    print("error: PyYAML required (pip install pyyaml)", file=sys.stderr)
    sys.exit(1)

ROOT = Path(__file__).resolve().parents[1]
REF = ROOT / "_ref" / "linguist" / "lib" / "linguist"
OUT_DIR = ROOT / "src" / "generated"


def write_json(path: Path, data: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, separators=(",", ":")))
    print(f"Wrote {path} ({path.stat().st_size} bytes)")


def build_aliases(langs: dict) -> dict[str, str]:
    """Map lowercase alias / name → canonical language name."""
    out: dict[str, str] = {}
    for name, meta in langs.items():
        if not isinstance(meta, dict):
            continue
        out[name.lower()] = name
        for a in meta.get("aliases") or []:
            out[str(a).lower()] = name
        # Also map fs_name / ace_mode style names when present
        for key in ("fs_name", "ace_mode", "codemirror_mode", "tm_scope"):
            v = meta.get(key)
            if isinstance(v, str) and v:
                out.setdefault(v.lower(), name)
    return out


def main() -> None:
    if not (REF / "languages.yml").is_file():
        print(
            f"error: missing {REF / 'languages.yml'}\n"
            "Clone github-linguist into freenet-linguist/_ref/linguist first.",
            file=sys.stderr,
        )
        sys.exit(1)

    langs = yaml.safe_load((REF / "languages.yml").read_text())
    vendor = yaml.safe_load((REF / "vendor.yml").read_text()) or []
    docs = yaml.safe_load((REF / "documentation.yml").read_text()) or []
    popular = yaml.safe_load((REF / "popular.yml").read_text()) or []
    generic = yaml.safe_load((REF / "generic.yml").read_text()) or {"extensions": []}
    heuristics = yaml.safe_load((REF / "heuristics.yml").read_text()) or {}

    catalog = {
        "source": "github-linguist/linguist (languages.yml + vendor.yml + documentation.yml + popular.yml)",
        "languages": {},
        "extension_index": {},
        "filename_index": {},
        "vendor_patterns": vendor,
        "documentation_patterns": docs,
        "popular": popular,
    }

    for name, meta in langs.items():
        if not isinstance(meta, dict):
            continue
        entry = {
            "name": name,
            "type": meta.get("type", "programming"),
            "color": meta.get("color"),
            "group": meta.get("group"),
            "extensions": meta.get("extensions") or [],
            "filenames": meta.get("filenames") or [],
            "interpreters": meta.get("interpreters") or [],
        }
        catalog["languages"][name] = entry
        for ext in entry["extensions"]:
            catalog["extension_index"].setdefault(ext.lower(), []).append(name)
        for fn in entry["filenames"]:
            catalog["filename_index"].setdefault(fn.lower(), []).append(name)

    write_json(OUT_DIR / "catalog.json", catalog)
    write_json(OUT_DIR / "aliases.json", build_aliases(langs))
    write_json(OUT_DIR / "generic.json", generic)
    write_json(OUT_DIR / "heuristics.json", heuristics)

    # Path-based generated names from Linguist generated.rb constants when available
    gen_rb = REF / "generated.rb"
    if gen_rb.is_file():
        text = gen_rb.read_text()
        # Lightweight: keep existing generated-names.json unless we parse more later
        print(f"Note: {gen_rb.name} present — generated-names.json is maintained separately")


if __name__ == "__main__":
    main()

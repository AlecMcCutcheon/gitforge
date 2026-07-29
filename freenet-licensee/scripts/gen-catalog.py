#!/usr/bin/env python3
"""Build freenet-licensee licenses.json from choosealicense.com texts (via licensee vendor/).

  Clone/link licensee into freenet-licensee/_ref/licensee, then:
  python3 freenet-licensee/scripts/gen-catalog.py
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    print("error: PyYAML required (pip install pyyaml)", file=sys.stderr)
    sys.exit(1)

ROOT = Path(__file__).resolve().parents[1]
LIC_DIR = (
    ROOT / "_ref" / "licensee" / "vendor" / "choosealicense.com" / "_licenses"
)
OUT = ROOT / "src" / "generated" / "licenses.json"

FRONT = re.compile(r"\A---\s*\n(.*?)\n---\s*\n(.*)\Z", re.S)


def main() -> None:
    if not LIC_DIR.is_dir():
        print(f"error: missing {LIC_DIR}", file=sys.stderr)
        sys.exit(1)

    licenses: dict[str, dict] = {}
    for path in sorted(LIC_DIR.glob("*.txt")):
        raw = path.read_text(encoding="utf-8")
        m = FRONT.match(raw)
        if not m:
            print(f"warn: skip {path.name} (no front matter)", file=sys.stderr)
            continue
        meta = yaml.safe_load(m.group(1)) or {}
        body = m.group(2).strip() + "\n"
        key = path.stem  # e.g. mit, apache-2.0
        licenses[key] = {
            "key": key,
            "title": meta.get("title") or key,
            "spdx_id": meta.get("spdx-id") or meta.get("spdx_id"),
            "featured": bool(meta.get("featured")),
            "hidden": bool(meta.get("hidden")),
            "nickname": meta.get("nickname"),
            "description": meta.get("description"),
            "content": body,
        }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "source": "choosealicense.com via licensee vendor/_licenses",
        "fields": [
            "fullname",
            "login",
            "email",
            "project",
            "description",
            "year",
            "projecturl",
        ],
        "licenses": licenses,
    }
    OUT.write_text(json.dumps(payload, separators=(",", ":")))
    print(f"Wrote {OUT} ({len(licenses)} licenses, {OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()

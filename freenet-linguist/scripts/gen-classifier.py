#!/usr/bin/env python3
"""Fast extract of go-enry frequencies.go → classifier.json[.gz].

Converts the already-quoted Go map literals into JSON (no token-by-token walk).
"""
from __future__ import annotations

import gzip
import json
import re
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "src" / "generated"
DEFAULT_SRC = Path("/tmp/go-enry/data/frequencies.go")


def extract_brace_block(src: str, start_idx: int) -> str:
    """Return substring of outer `{...}` starting at start_idx (must be '{')."""
    assert src[start_idx] == "{"
    depth = 0
    i = start_idx
    n = len(src)
    while i < n:
        c = src[i]
        if c == '"':
            i += 1
            while i < n:
                if src[i] == "\\":
                    i += 2
                    continue
                if src[i] == '"':
                    i += 1
                    break
                i += 1
            continue
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return src[start_idx : i + 1]
        i += 1
    raise RuntimeError("unbalanced braces")


def go_map_to_json(block: str) -> object:
    """Turn a Go map[string]...{ ... } body into a Python object via JSON."""
    # Strip typed map wrappers, keep braces/content
    s = re.sub(r"map\[string\](?:map\[string\])?float64", "", block)
    # Remove trailing commas before } or ]
    s = re.sub(r",(\s*[}\]])", r"\1", s)
    # Go \xNN → JSON \u00NN
    s = re.sub(
        r"\\x([0-9a-fA-F]{2})",
        lambda m: f"\\u00{m.group(1).lower()}",
        s,
    )
    return json.loads(s)


def main() -> None:
    src_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_SRC
    if not src_path.is_file():
        print(f"error: missing {src_path}", file=sys.stderr)
        sys.exit(1)

    t0 = time.time()
    print(f"Reading {src_path} …", flush=True)
    src = src_path.read_text()

    m = re.search(r"var TokensTotal = ([0-9.]+)", src)
    if not m:
        print("error: TokensTotal not found", file=sys.stderr)
        sys.exit(1)
    tokens_total = int(float(m.group(1)))

    print("Parsing LanguagesLogProbabilities …", flush=True)
    i = src.index("var LanguagesLogProbabilities = map[string]float64{")
    i = src.index("{", i)
    lang_probs = go_map_to_json(extract_brace_block(src, i))

    print("Parsing TokensLogProbabilities …", flush=True)
    i = src.index("var TokensLogProbabilities = map[string]map[string]float64{")
    i = src.index("{", i)
    token_probs = go_map_to_json(extract_brace_block(src, i))

    db = {
        "source": "go-enry frequencies.go (Naive Bayes from github/linguist samples)",
        "tokens_total": tokens_total,
        "languages_log_probabilities": lang_probs,
        "tokens_log_probabilities": token_probs,
    }
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    print("Writing JSON …", flush=True)
    raw = json.dumps(db, separators=(",", ":")).encode()
    (OUT_DIR / "classifier.json").write_bytes(raw)
    with gzip.open(OUT_DIR / "classifier.json.gz", "wb", compresslevel=9) as f:
        f.write(raw)

    print(
        f"langs {len(lang_probs)} token-langs {len(token_probs)} "
        f"token entries {sum(len(v) for v in token_probs.values())}"
    )
    print(
        f"json MB {round(len(raw) / 1e6, 2)} "
        f"gz MB {round((OUT_DIR / 'classifier.json.gz').stat().st_size / 1e6, 2)} "
        f"in {time.time() - t0:.1f}s"
    )


if __name__ == "__main__":
    main()

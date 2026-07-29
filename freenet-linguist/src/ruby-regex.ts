/**
 * Compile Linguist / Oniguruma-flavored patterns for JavaScript RegExp.
 * Handles common (?i)/(?m)/(?x) flags; unsupported constructs → null.
 */

function stripExtendedWhitespace(pattern: string): string {
  // Rough (?x) mode: drop unescaped whitespace and # comments outside classes.
  let out = "";
  let inClass = false;
  let escaped = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (escaped) {
      out += c;
      escaped = false;
      continue;
    }
    if (c === "\\") {
      out += c;
      escaped = true;
      continue;
    }
    if (c === "[" && !inClass) {
      inClass = true;
      out += c;
      continue;
    }
    if (c === "]" && inClass) {
      inClass = false;
      out += c;
      continue;
    }
    if (!inClass && (c === " " || c === "\t" || c === "\n" || c === "\r")) {
      continue;
    }
    if (!inClass && c === "#") {
      while (i < pattern.length && pattern[i] !== "\n") i++;
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * Convert a Linguist YAML regex string to a JS RegExp, or null if unsupported.
 */
export function compileLinguistRegex(
  source: string,
  extraFlags = "",
): RegExp | null {
  const flagSet = new Set(
    [...extraFlags].filter((c) => "imsuygd".includes(c)),
  );
  let pat = source;
  let extended = false;

  // Leading option groups: (?i), (?im), (?xi), (?-m), (?x), …
  pat = pat.replace(/^\(\?([imsx-]*)\)\s*/, (_m, opts: string) => {
    let neg = false;
    for (const c of opts) {
      if (c === "-") {
        neg = true;
        continue;
      }
      if (c === "x") {
        if (!neg) extended = true;
        neg = false;
        continue;
      }
      if (c === "i" || c === "m" || c === "s") {
        if (!neg) flagSet.add(c === "s" ? "s" : c);
        else flagSet.delete(c === "s" ? "s" : c);
      }
      neg = false;
    }
    return "";
  });

  // Inline-only flags still used mid-pattern in generated names / heuristics
  if (/\(\?i\)/.test(pat)) {
    flagSet.add("i");
    pat = pat.replace(/\(\?i\)/g, "");
  }
  if (/\(\?m\)/.test(pat)) {
    flagSet.add("m");
    pat = pat.replace(/\(\?m\)/g, "");
  }
  if (/\(\?-m\)/.test(pat)) {
    pat = pat.replace(/\(\?-m\)/g, "");
  }
  if (/\(\?im\)/.test(pat)) {
    flagSet.add("i");
    flagSet.add("m");
    pat = pat.replace(/\(\?im\)/g, "");
  }
  if (/\(\?x\)/.test(pat)) {
    extended = true;
    pat = pat.replace(/\(\?x\)/g, "");
  }
  if (/\(\?xi\)/.test(pat)) {
    extended = true;
    flagSet.add("i");
    pat = pat.replace(/\(\?xi\)/g, "");
  }

  // (?i:…) / (?im:…) scoped flags → non-capturing + global i/m
  if (/\(\?i:/.test(pat)) {
    flagSet.add("i");
    pat = pat.replace(/\(\?i:/g, "(?:");
  }
  if (/\(\?im:/.test(pat)) {
    flagSet.add("i");
    flagSet.add("m");
    pat = pat.replace(/\(\?im:/g, "(?:");
  }

  if (extended) {
    pat = stripExtendedWhitespace(pat);
  }

  // Oniguruma named backrefs — not in JS; skip pattern
  if (/\\g</.test(pat)) return null;

  const flags = [...flagSet].join("");
  try {
    return new RegExp(pat, flags);
  } catch {
    return null;
  }
}

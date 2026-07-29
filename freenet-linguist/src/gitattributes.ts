/**
 * Parse `.gitattributes` linguist-* overrides (subset of git attr pathspecs).
 */
export interface LinguistAttrs {
  language?: string;
  vendored?: boolean;
  generated?: boolean;
  documentation?: boolean;
  detectable?: boolean;
}

export interface GitattributesRules {
  /** Ordered rules; later wins (git attributes merge). */
  rules: { pattern: string; attrs: LinguistAttrs }[];
}

function parseAttrLine(
  line: string,
): { pattern: string; attrs: LinguistAttrs } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const parts = trimmed.split(/\s+/);
  if (parts.length < 2) return null;
  const pattern = parts[0]!;
  const attrs: LinguistAttrs = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf("=");
    const rawKey = eq >= 0 ? p.slice(0, eq) : p;
    const v = eq >= 0 ? p.slice(eq + 1) : undefined;
    const unset = rawKey.startsWith("-");
    const key = rawKey.replace(/^-/, "");
    if (key === "linguist-language" && v) attrs.language = v;
    if (key === "linguist-vendored") {
      attrs.vendored = unset ? false : v !== "false";
    }
    if (key === "linguist-generated") {
      attrs.generated = unset ? false : v !== "false";
    }
    if (key === "linguist-documentation") {
      attrs.documentation = unset ? false : v !== "false";
    }
    if (key === "linguist-detectable") {
      attrs.detectable = unset ? false : v !== "false";
    }
  }
  return { pattern, attrs };
}

/** Convert a simple gitignore-like pattern to RegExp (common cases). */
function patternToRegExp(pattern: string): RegExp {
  let p = pattern.replace(/\\/g, "/");
  if (p.startsWith("/")) p = p.slice(1);
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === "*" && p[i + 1] === "*") {
      re += ".*";
      i++;
      if (p[i + 1] === "/") i++;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (".+^$()[]{}|".includes(c)) re += `\\${c}`;
    else re += c;
  }
  return new RegExp(`(?:^|/)${re}$`);
}

export function parseGitattributes(text: string): GitattributesRules {
  const rules: GitattributesRules["rules"] = [];
  for (const line of text.split(/\r?\n/)) {
    const row = parseAttrLine(line);
    if (row) rules.push(row);
  }
  return { rules };
}

export function attrsForPath(
  rules: GitattributesRules | null | undefined,
  path: string,
): LinguistAttrs {
  if (!rules?.rules.length) return {};
  const norm = path.replace(/\\/g, "/");
  let out: LinguistAttrs = {};
  for (const rule of rules.rules) {
    try {
      if (patternToRegExp(rule.pattern).test(norm)) {
        out = { ...out, ...rule.attrs };
      }
    } catch {
      /* ignore bad patterns */
    }
  }
  return out;
}

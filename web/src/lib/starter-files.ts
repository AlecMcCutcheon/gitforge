/** Starter file templates for empty-repo create flow (GitHub-like). */

import { generateLicense } from "@freenet-hub/licensee";

export type StarterKind = "readme" | "license" | "gitignore";

export interface StarterFile {
  kind: StarterKind;
  /** Path relative to repo root. */
  path: string;
  /** Suggested commit subject. */
  commitSubject: string;
  content: string;
}

export function readmeTemplate(repoLabel: string): StarterFile {
  const name = repoLabel.trim() || "Repository";
  return {
    kind: "readme",
    path: "README.md",
    commitSubject: "Add README.md",
    content: `# ${name}\n`,
  };
}

export function licenseTemplate(
  key = "mit",
  fields?: {
    fullname?: string;
    project?: string;
    year?: number;
  },
): StarterFile {
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // Hard-coded MIT text…
  // NEW CODE - TESTING: choosealicense generate via @freenet-hub/licensee
  let content: string;
  try {
    content = generateLicense(key, {
      year: fields?.year ?? new Date().getFullYear(),
      fullname: fields?.fullname ?? "",
      project: fields?.project ?? "",
    });
  } catch {
    content = generateLicense("mit", {
      year: fields?.year ?? new Date().getFullYear(),
      fullname: fields?.fullname ?? "",
      project: fields?.project ?? "",
    });
  }
  return {
    kind: "license",
    path: "LICENSE",
    commitSubject: "Add LICENSE",
    content,
  };
}

export function gitignoreTemplate(): StarterFile {
  return {
    kind: "gitignore",
    path: ".gitignore",
    commitSubject: "Add .gitignore",
    content: `# Dependencies
node_modules/
target/
dist/
build/

# Env / secrets
.env
.env.*
!.env.example

# OS / editor
.DS_Store
Thumbs.db
*.swp
.idea/
.vscode/
`,
  };
}

export function starterForKind(
  kind: StarterKind,
  repoLabel: string,
  licenseKey = "mit",
): StarterFile {
  switch (kind) {
    case "readme":
      return readmeTemplate(repoLabel);
    case "license":
      return licenseTemplate(licenseKey, { project: repoLabel });
    case "gitignore":
      return gitignoreTemplate();
  }
}

/**
 * Autofill path when the user types a bare name (e.g. "readme" → README.md).
 * Returns null when the input already looks like a path or is empty.
 */
export function autofillFilePath(raw: string): string | null {
  const t = raw.trim();
  if (!t || t.includes("/") || t.includes(".")) return null;
  const key = t.toLowerCase().replace(/[\s_]+/g, "");
  if (key === "readme" || key === "readmd") return "README.md";
  if (key === "license" || key === "licence" || key === "mit") return "LICENSE";
  if (key === "gitignore" || key === "ignore") return ".gitignore";
  return null;
}

/** Editor language hint from path (for toolbar label). */
export function languageHintForPath(path: string): string {
  const base = path.split("/").pop()?.toLowerCase() ?? "";
  if (base.endsWith(".md") || base === "readme") return "Markdown";
  if (base === "license" || base === "licence" || base.endsWith(".txt"))
    return "Text";
  if (base === ".gitignore" || base.endsWith(".gitignore")) return "Ignore list";
  if (base.endsWith(".json")) return "JSON";
  if (base.endsWith(".ts") || base.endsWith(".tsx")) return "TypeScript";
  if (base.endsWith(".js") || base.endsWith(".jsx")) return "JavaScript";
  if (base.endsWith(".rs")) return "Rust";
  if (base.endsWith(".py")) return "Python";
  if (base.endsWith(".css")) return "CSS";
  if (base.endsWith(".html") || base.endsWith(".htm")) return "HTML";
  if (base.endsWith(".yml") || base.endsWith(".yaml")) return "YAML";
  if (base.endsWith(".toml")) return "TOML";
  if (base.endsWith(".sh")) return "Shell";
  return "Plain text";
}

export function defaultContentForPath(
  path: string,
  repoLabel: string,
  licenseKey = "mit",
): string {
  const base = path.split("/").pop()?.toLowerCase() ?? "";
  if (base === "readme.md" || base === "readme") {
    return readmeTemplate(repoLabel).content;
  }
  if (base === "license" || base === "licence" || base === "license.md") {
    return licenseTemplate(licenseKey, { project: repoLabel }).content;
  }
  if (base === ".gitignore") {
    return gitignoreTemplate().content;
  }
  return "";
}

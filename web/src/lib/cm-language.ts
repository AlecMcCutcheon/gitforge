/**
 * Resolve CodeMirror 6 language support from a file path (GitHub-style).
 * Uses @codemirror/language-data loaders so modes are code-split.
 */
import type { Extension } from "@codemirror/state";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";

export function isMarkdownFilePath(path: string | undefined): boolean {
  if (!path) return false;
  const base = path.split("/").pop() || path;
  return /\.(md|markdown|mdown|mkd)$/i.test(base) || base === "README";
}

export async function languageExtensionsForPath(
  path: string | undefined,
): Promise<Extension[]> {
  if (!path?.trim()) return [];
  const base = path.split("/").pop() || path;

  if (isMarkdownFilePath(path)) {
    return [
      markdown({
        base: markdownLanguage,
        codeLanguages: languages,
      }),
    ];
  }

  const desc = LanguageDescription.matchFilename(languages, base);
  if (!desc) return [];
  try {
    return [await desc.load()];
  } catch {
    return [];
  }
}

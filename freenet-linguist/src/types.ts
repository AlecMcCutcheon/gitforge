/**
 * Catalog types for generated Linguist-derived JSON.
 */

export type LanguageType = "data" | "programming" | "markup" | "prose";

export interface LanguageDef {
  name: string;
  type: LanguageType;
  color: string | null;
  /** Parent language for stats rollup (Linguist `group`). */
  group: string | null;
  extensions: string[];
  filenames: string[];
  interpreters: string[];
}

export interface LinguistCatalog {
  source: string;
  languages: Record<string, LanguageDef>;
  /** extension (with leading dot) → candidate language names */
  extension_index: Record<string, string[]>;
  filename_index: Record<string, string[]>;
  vendor_patterns: string[];
  documentation_patterns: string[];
  /** Popular language names (tie-break order; lower index = more popular). */
  popular?: string[];
}

export interface PathSize {
  path: string;
  size: number;
}

export interface LanguageSlice {
  name: string;
  color: string | null;
  bytes: number;
  percent: number;
}

export interface LanguageBreakdown {
  totalBytes: number;
  languages: LanguageSlice[];
  /** Paths skipped as vendor/docs/binary/unknown. */
  skipped: number;
}

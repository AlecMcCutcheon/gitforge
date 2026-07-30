/**
 * @gitforge/linguist — Freenet/GitForge language detection.
 * Full strategy funnel aligned with github/linguist + go-enry.
 */
export { analyzeFiles, analyzeFilesAsync, analyzeFilesPathOnly } from "./analyze";
export type { AnalyzeFile, AnalyzeOptions } from "./analyze";
export { isBinaryContent } from "./binary";
export {
  classifyContent,
  ensureClassifier,
} from "./classifier";
export type { ClassifierDb } from "./classifier";
export {
  catalog,
  classifyPath,
  isDocumentationPath,
  isLikelyBinaryPath,
  isVendoredPath,
  languageColor,
  pathDetectionNeedsContent,
  statsLanguageName,
} from "./classify";
export {
  detectLanguage,
  detectLanguageAsync,
  languageType,
} from "./detect";
export type { DetectOptions } from "./detect";
export { isGenerated } from "./generated";
export {
  attrsForPath,
  parseGitattributes,
} from "./gitattributes";
export type { GitattributesRules, LinguistAttrs } from "./gitattributes";
export { applyHeuristics } from "./heuristics";
export { tokenize } from "./tokenizer";
export type {
  LanguageBreakdown,
  LanguageDef,
  LanguageSlice,
  LanguageType,
  LinguistCatalog,
  PathSize,
} from "./types";

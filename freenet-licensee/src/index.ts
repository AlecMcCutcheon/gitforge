/**
 * @freenet-hub/licensee — browser port of licensee detection + choosealicense generate.
 */
export { catalog, getLicense, listLicenses } from "./catalog";
export { discoverCommunityFiles } from "./community";
export { detectLicense, licenseTabLabel } from "./detect";
export { findLicenseCandidates } from "./find";
export { generateLicense } from "./generate";
export type {
  CommunityFiles,
  DetectResult,
  LicenseFields,
  LicenseMeta,
  PathContent,
} from "./types";

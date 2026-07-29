/** Shared types for @freenet-hub/licensee. */

export interface LicenseMeta {
  key: string;
  title: string;
  spdx_id: string | null;
  featured: boolean;
  hidden: boolean;
  nickname?: string | null;
  description?: string | null;
  content: string;
}

export interface LicensesCatalog {
  source: string;
  fields: string[];
  licenses: Record<string, LicenseMeta>;
}

export interface LicenseFields {
  fullname?: string;
  login?: string;
  email?: string;
  project?: string;
  description?: string;
  year?: string | number;
  projecturl?: string;
}

export interface PathContent {
  path: string;
  content: string;
}

export interface DetectResult {
  key: string | null;
  spdxId: string | null;
  title: string | null;
  confidence: number;
  matcher: "copyright" | "exact" | "dice" | null;
  path: string | null;
}

export interface CommunityFiles {
  readme: string | null;
  license: string | null;
  codeOfConduct: string | null;
  contributing: string | null;
  security: string | null;
}

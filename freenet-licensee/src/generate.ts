import { getLicense } from "./catalog";
import type { LicenseFields } from "./types";

/**
 * Fill choosealicense placeholders (GitHub create-repo behavior).
 * Placeholders: [year], [fullname], [login], [email], [project], [description], [projecturl]
 */
export function generateLicense(
  keyOrSpdx: string,
  fields: LicenseFields = {},
): string {
  const lic = getLicense(keyOrSpdx);
  if (!lic) {
    throw new Error(`Unknown license: ${keyOrSpdx}`);
  }
  const year = String(fields.year ?? new Date().getFullYear());
  const map: Record<string, string> = {
    year,
    fullname: fields.fullname ?? fields.login ?? "",
    login: fields.login ?? "",
    email: fields.email ?? "",
    project: fields.project ?? "",
    description: fields.description ?? "",
    projecturl: fields.projecturl ?? "",
  };
  return lic.content.replace(/\[([a-z0-9_]+)\]/gi, (_m, name: string) => {
    const v = map[name.toLowerCase()];
    return v != null ? v : `[${name}]`;
  });
}

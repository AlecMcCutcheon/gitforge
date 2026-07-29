/** Short hex from email for disambiguating same-named contributors. */
export function shortEmailHash(email: string | null | undefined): string {
  if (!email) return "????";
  let h = 2166136261;
  const s = email.trim().toLowerCase();
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0").slice(0, 4);
}

export function collapseCommitSubject(subject: string | null | undefined): string {
  if (!subject) return "";
  return subject.replace(/\s+/g, " ").trim();
}

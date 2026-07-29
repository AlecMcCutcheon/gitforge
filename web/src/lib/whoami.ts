/** Parse freenet-git whoami stdout (best-effort). */
export function parseWhoamiStdout(stdout: string): {
  name: string;
  email: string | null;
  fingerprint: string;
  repos: Array<{ prefix: string; label: string }>;
} | null {
  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return null;

  const nameEmail = /^(.+?)\s*<([^>]+)>$/.exec(lines[0]);
  const name = nameEmail ? nameEmail[1].trim() : lines[0];
  const email = nameEmail ? nameEmail[2].trim() : null;
  const fingerprint = lines[1];

  const repos: Array<{ prefix: string; label: string }> = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const m =
      /freenet::([1-9A-HJ-NP-Za-km-z]+)\/([A-Za-z0-9._~-]+)/.exec(line) ??
      /freenet:([1-9A-HJ-NP-Za-km-z]+)\/([A-Za-z0-9._~-]+)/.exec(line);
    if (!m) continue;
    const key = `${m[1]}/${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    repos.push({ prefix: m[1], label: m[2] });
  }

  return { name, email, fingerprint, repos };
}

/**
 * Path / content strategies matching Linguist STRATEGIES order
 * (modeline → filename → shebang → extension → XML → manpage).
 */
import aliasesJson from "./generated/aliases.json";
import genericJson from "./generated/generic.json";
import { catalog } from "./classify";

const aliases = aliasesJson as Record<string, string>;
const genericExts = (genericJson as { extensions: string[] }).extensions;

/** Reverse interpreter → languages (from catalog). */
const byInterpreter = new Map<string, string[]>();
for (const def of Object.values(catalog.languages)) {
  for (const interp of def.interpreters) {
    const list = byInterpreter.get(interp) ?? [];
    list.push(def.name);
    byInterpreter.set(interp, list);
  }
}

export function languageByAlias(alias: string): string | null {
  const key = alias.trim().toLowerCase();
  return aliases[key] ?? catalog.languages[alias]?.name ?? null;
}

function decode(content: string | Uint8Array): string {
  return typeof content === "string"
    ? content
    : new TextDecoder("utf-8", { fatal: false }).decode(content);
}

function headFoot(content: string, scope = 5): string {
  const lines = content.split(/\r?\n/);
  if (lines.length <= scope * 2) return content;
  return [...lines.slice(0, scope), ...lines.slice(-scope)].join("\n");
}

const reEmacsModeline = /-\*-\s*(.+?)\s*-\*-/g;
const reEmacsLang = /mode\s*:\s*([^\s;]+)/i;
const reVimModeline =
  /(?:(?:^|\s)vi(?:m[<=>]?\d+|m)?|[\t ]*ex)\s*:\s*(.+)$/gim;
const reVimLang = /(?:filetype|ft|syntax)\s*=(\w+)/i;

export function strategyModeline(content: string | Uint8Array): string[] {
  const text = headFoot(decode(content));
  if (text.includes("UseVimball")) return [];

  const emacs = [...text.matchAll(reEmacsModeline)];
  if (emacs.length > 0) {
    const last = emacs[emacs.length - 1]![1]!;
    const mode = reEmacsLang.exec(last)?.[1] ?? last;
    const lang = languageByAlias(mode);
    if (lang) return [lang];
  }

  const vim = [...text.matchAll(reVimModeline)];
  if (vim.length > 0) {
    const last = vim[vim.length - 1]![1]!;
    const ft = reVimLang.exec(last)?.[1];
    if (ft) {
      const lang = languageByAlias(ft);
      if (lang) return [lang];
    }
  }
  return [];
}

export function strategyFilename(
  path: string,
  candidates: string[] = [],
): string[] {
  const base = path.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
  const languages = catalog.filename_index[base]
    ? [...catalog.filename_index[base]!]
    : [];
  if (candidates.length === 0) return languages;
  if (languages.length === 0) return [];
  const set = new Set(candidates);
  return languages.filter((n) => set.has(n));
}

const envOptArgs = /^-[i0uCSv]*$|^--\S+$/;
const envVarArgs = /^\S+=\S+$/;
const pythonVersion = /^python\d\.\d+/;
const shebangExecHack = /exec (\w+).+\$0.+\$@/;

function getInterpreter(content: string | Uint8Array): string {
  const text = decode(content);
  const first = text.split(/\r?\n/, 1)[0] ?? "";
  if (!first.startsWith("#!")) return "";
  let line = first.slice(2).trim();
  let parts = line.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "";
  let interpreter = parts[0]!.split("/").pop() ?? "";

  if (interpreter === "env") {
    if (parts.length < 2) return "";
    parts = parts.slice(0);
    while (parts.length > 2) {
      if (envOptArgs.test(parts[1]!) || envVarArgs.test(parts[1]!)) {
        parts = [parts[0]!, ...parts.slice(2)];
        continue;
      }
      break;
    }
    interpreter = (parts[1] ?? "").split("/").pop() ?? "";
  }

  if (interpreter === "sh") {
    const head = text.split(/\r?\n/).slice(0, 5).join("\n");
    const m = shebangExecHack.exec(head);
    if (m) interpreter = m[1]!;
  }

  if (pythonVersion.test(interpreter)) {
    interpreter = interpreter.slice(0, interpreter.indexOf("."));
  }

  if (interpreter === "osascript" && line.includes("-l")) return "";

  // python2.6 → python2 (linguist shebang.rb)
  interpreter = interpreter.replace(/(\.\d+)$/, "");
  return interpreter;
}

export function strategyShebang(
  content: string | Uint8Array,
  candidates: string[] = [],
): string[] {
  const interp = getInterpreter(content);
  if (!interp) return [];
  const languages = byInterpreter.get(interp)
    ? [...byInterpreter.get(interp)!]
    : [];
  if (candidates.length === 0) return languages;
  if (languages.length === 0) return [];
  const set = new Set(candidates);
  return languages.filter((n) => set.has(n));
}

function isGenericExtension(filename: string): boolean {
  const lower = filename.toLowerCase();
  return genericExts.some((ext) => lower.endsWith(ext));
}

/**
 * Extension strategy — intersects with prior candidates when present
 * (Linguist Extension.call). Skips generic extensions.
 */
export function strategyExtension(
  path: string,
  candidates: string[] = [],
): string[] {
  const base = path.replace(/\\/g, "/").split("/").pop() ?? "";
  if (isGenericExtension(base)) return candidates;

  const lower = base.toLowerCase();
  let best: string[] = [];
  let bestLen = -1;
  for (const [ext, langs] of Object.entries(catalog.extension_index)) {
    if (lower.endsWith(ext) && ext.length > bestLen) {
      best = [...langs];
      bestLen = ext.length;
    }
  }
  if (candidates.length === 0) return best;
  if (best.length === 0) return candidates;
  const set = new Set(candidates);
  return best.filter((n) => set.has(n));
}

export function strategyXml(
  content: string | Uint8Array,
  candidates: string[],
): string[] {
  if (candidates.length > 0) return candidates;
  const header = decode(content).split(/\r?\n/).slice(0, 2).join("\n");
  return /<\?xml\s+version=/i.test(header) ? ["XML"] : [];
}

const MANPAGE_EXTS =
  /\.(?:[1-9](?![0-9])[a-z_0-9]*|0p|n|man|mdoc)(?:\.in)?$/i;

export function strategyManpage(
  path: string,
  candidates: string[],
): string[] {
  if (candidates.length > 0) return candidates;
  const base = path.replace(/\\/g, "/").split("/").pop() ?? "";
  if (MANPAGE_EXTS.test(base)) return ["Roff Manpage", "Roff"];
  return [];
}

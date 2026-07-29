/**
 * Linguist-compatible tokenizer (ported from go-enry / linguist C tokenizer).
 * At most the first BYTE_LIMIT bytes are considered.
 */
const BYTE_LIMIT = 100_000;

const reLiteralStringQuotes = /("(?:.|\n)*?"|'(?:.|\n)*?')/g;
const reSingleLineComment = /(?:\/\/|--|#|%|")\s([^\n]*$)/gm;
const reMultilineComment =
  /(\/\*(?:.|\n)*?\*\/|<!--(?:.|\n)*?-->|\{-(?:.|\n)*?-\}|\(\*(?:.|\n)*?\*\)|"""(?:.|\n)*?"""|'''(?:.|\n)*?''')/g;
const reLiteralNumber =
  /(0x[0-9A-Fa-f](?:[0-9A-Fa-f]|\.)*|\d(?:\d|\.)*)(?:[uU][lL]{0,2}|(?:[eE][-+]\d*)?[fFlL]*)/g;
const reShebang =
  /^#!(?:\/[0-9A-Za-z_]+)*\/(?:([0-9A-Za-z_]+)|[0-9A-Za-z_]+(?:\s*[0-9A-Za-z_]+=[0-9A-Za-z_]+\s*)*\s*([0-9A-Za-z_]+))(?:\s*-[0-9A-Za-z_]+\s*)*$/gm;
const rePunctuation = /;|\{|\}|\(|\)|\[|\]/g;
const reSGML = /(<\/?[^\s<>=\d"']+)(?:\s(?:.|\n)*?\/?>|>)/g;
const reSGMLAttributes = /\s+([0-9A-Za-z_]+=)|\s+([^\s>]+)/g;
const reSGMLLoneAttribute = /([0-9A-Za-z_]+)/g;
const reRegularToken = /[0-9A-Za-z_.@#/*]+/g;
const reOperators = /<<?|\+|-|\*|\/|%|&&?|\|\|?/g;

function extractShebang(content: string): { content: string; tokens: string[] } {
  const tokens: string[] = [];
  const out = content.replace(reShebang, (_full, a?: string, b?: string) => {
    const name = a || b || "";
    if (name) tokens.push(`SHEBANG#!${name}`);
    return " ";
  });
  return { content: out, tokens };
}

function skipCommentsAndLiterals(content: string): string {
  let c = content.replace(reLiteralStringQuotes, (m) => " ".repeat(m.length));
  c = c.replace(reMultilineComment, (m) => " ".repeat(m.length));
  c = c.replace(reSingleLineComment, (m) => " ".repeat(m.length));
  c = c.replace(reLiteralNumber, (m) => " ".repeat(m.length));
  return c;
}

function extractSGML(content: string): { content: string; tokens: string[] } {
  const tokens: string[] = [];
  const out = content.replace(reSGML, (full, tag: string) => {
    tokens.push(tag);
    // attribute names inside the tag remainder
    const rest = full.slice(tag.length);
    for (const am of rest.matchAll(reSGMLAttributes)) {
      if (am[1]) tokens.push(am[1]);
      else if (am[2]) {
        for (const lone of am[2].matchAll(reSGMLLoneAttribute)) {
          tokens.push(lone[1]!);
        }
      }
    }
    return " ".repeat(full.length);
  });
  return { content: out, tokens };
}

function extractPunctuation(content: string): {
  content: string;
  tokens: string[];
} {
  const tokens: string[] = [];
  const out = content.replace(rePunctuation, (m) => {
    tokens.push(m);
    return " ";
  });
  return { content: out, tokens };
}

function extractRegular(content: string): { content: string; tokens: string[] } {
  const tokens: string[] = [];
  const out = content.replace(reRegularToken, (m) => {
    tokens.push(m);
    return " ".repeat(m.length);
  });
  return { content: out, tokens };
}

function extractOperators(content: string): {
  content: string;
  tokens: string[];
} {
  const tokens: string[] = [];
  const out = content.replace(reOperators, (m) => {
    tokens.push(m);
    return " ";
  });
  return { content: out, tokens };
}

function extractRemainders(content: string): string[] {
  return content.split(/\s+/).filter((t) => t.length > 0);
}

/** Tokenize file content the way Linguist/enry does for the classifier. */
export function tokenize(input: string | Uint8Array): string[] {
  let content =
    typeof input === "string"
      ? input
      : new TextDecoder("utf-8", { fatal: false }).decode(input);
  if (content.length > BYTE_LIMIT) content = content.slice(0, BYTE_LIMIT);

  const all: string[] = [];
  let c = content;

  {
    const r = extractShebang(c);
    c = r.content;
    all.push(...r.tokens);
  }
  {
    const r = extractSGML(c);
    c = r.content;
    all.push(...r.tokens);
  }
  c = skipCommentsAndLiterals(c);
  {
    const r = extractPunctuation(c);
    c = r.content;
    all.push(...r.tokens);
  }
  {
    const r = extractRegular(c);
    c = r.content;
    all.push(...r.tokens);
  }
  {
    const r = extractOperators(c);
    c = r.content;
    all.push(...r.tokens);
  }
  all.push(...extractRemainders(c));
  return all;
}

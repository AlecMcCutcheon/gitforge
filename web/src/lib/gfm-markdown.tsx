/**
 * Shared GFM markdown plugins for react-markdown.
 * remark-gfm alone does not parse raw HTML — rehype-raw is required for
 * GitHub-style embedded HTML, then rehype-sanitize keeps it safe.
 *
 * Shields.io images are rewritten to local badge-maker SVGs (data: URIs)
 * so README badges work under Freenet sandbox CSP.
 */
import type { ImgHTMLAttributes } from "react";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import type { Options as ReactMarkdownOptions } from "react-markdown";
import type { Schema } from "hast-util-sanitize";
import { shieldsUrlToDataUri } from "./shields-badge";

/**
 * Allowlist close to GitHub’s markdown HTML filter.
 * GFM disallows: title, textarea, style, xmp, iframe, noembed, noframes,
 * script, plaintext — those stay out of tagNames.
 */
const githubMarkdownSchema: Schema = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    "div",
    "span",
    "section",
    "article",
    "header",
    "footer",
    "main",
    "nav",
    "aside",
    "figure",
    "figcaption",
    "details",
    "summary",
    "abbr",
    "bdi",
    "bdo",
    "cite",
    "data",
    "dfn",
    "kbd",
    "mark",
    "q",
    "rp",
    "rt",
    "ruby",
    "samp",
    "small",
    "time",
    "var",
    "wbr",
    "picture",
    "source",
    "video",
    "audio",
    "track",
  ],
  attributes: {
    ...defaultSchema.attributes,
    "*": [
      ...(defaultSchema.attributes?.["*"] ?? []),
      "className",
      "id",
      "role",
      "ariaDescribedBy",
      "ariaHidden",
      "ariaLabel",
      "ariaLabelledBy",
    ],
    a: [
      ...(defaultSchema.attributes?.a ?? []),
      "name",
      "rel",
      "className",
      "id",
    ],
    img: [
      ...(defaultSchema.attributes?.img ?? []),
      "align",
      "width",
      "height",
      "loading",
      "className",
      "id",
    ],
    div: ["className", "id", "align", "role"],
    span: ["className", "id", "align"],
    section: ["className", "id"],
    article: ["className", "id"],
    header: ["className", "id"],
    footer: ["className", "id"],
    main: ["className", "id"],
    nav: ["className", "id"],
    aside: ["className", "id"],
    figure: ["className", "id"],
    figcaption: ["className", "id"],
    details: ["className", "id", "open"],
    summary: ["className", "id"],
    table: [
      ...(defaultSchema.attributes?.table ?? []),
      "className",
      "id",
      "align",
      "width",
    ],
    th: [
      ...(defaultSchema.attributes?.th ?? []),
      "className",
      "id",
      "align",
      "width",
      "colSpan",
      "rowSpan",
    ],
    td: [
      ...(defaultSchema.attributes?.td ?? []),
      "className",
      "id",
      "align",
      "width",
      "colSpan",
      "rowSpan",
    ],
    tr: ["className", "id", "align"],
    thead: ["className", "id"],
    tbody: ["className", "id"],
    tfoot: ["className", "id"],
    h1: ["className", "id", "align"],
    h2: ["className", "id", "align"],
    h3: ["className", "id", "align"],
    h4: ["className", "id", "align"],
    h5: ["className", "id", "align"],
    h6: ["className", "id", "align"],
    p: ["className", "id", "align"],
    ul: ["className", "id"],
    ol: ["className", "id", "start", "type"],
    li: ["className", "id"],
    code: ["className", "id"],
    pre: ["className", "id"],
    blockquote: ["className", "id"],
    video: [
      "src",
      "controls",
      "width",
      "height",
      "poster",
      "preload",
      "className",
      "id",
    ],
    audio: ["src", "controls", "preload", "className", "id"],
    source: ["src", "type", "media"],
    track: ["src", "kind", "srclang", "label", "default"],
  },
  // Keep protocols safe (no javascript:). data: needed for local shields SVGs.
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), "mailto"],
    src: [...(defaultSchema.protocols?.src ?? []), "data"],
  },
};

/** Replace shields.io <img src> with a locally rendered badge-maker data URI. */
function MarkdownImg({
  src,
  alt,
  title,
  ...rest
}: ImgHTMLAttributes<HTMLImageElement>) {
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // return <img src={src} alt={alt} title={title} {...rest} />;
  // NEW CODE - TESTING: Freenet CSP blocks clearnet images — render shields locally
  const local = typeof src === "string" ? shieldsUrlToDataUri(src) : null;
  return <img src={local ?? src} alt={alt} title={title} {...rest} />;
}

export const GFM_MARKDOWN_COMPONENTS: Components = {
  img: MarkdownImg,
};

/** Props spread onto every `<ReactMarkdown>` for GitHub-like GFM + safe HTML. */
export const GFM_MARKDOWN_PROPS: Pick<
  ReactMarkdownOptions,
  "remarkPlugins" | "rehypePlugins" | "components"
> = {
  remarkPlugins: [remarkGfm],
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // rehypePlugins: [rehypeSanitize] — stripped/ignored raw HTML (no rehype-raw)
  // NEW CODE - TESTING: parse HTML then sanitize to a GitHub-like allowlist
  rehypePlugins: [rehypeRaw, [rehypeSanitize, githubMarkdownSchema]],
  components: GFM_MARKDOWN_COMPONENTS,
};

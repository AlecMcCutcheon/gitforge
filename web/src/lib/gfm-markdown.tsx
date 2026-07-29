/**
 * Shared GFM markdown plugins for react-markdown.
 * remark-gfm alone does not parse raw HTML — rehype-raw is required for
 * GitHub-style embedded HTML, then rehype-sanitize keeps it safe.
 *
 * Shields.io images are rewritten to local badge-maker SVGs (data: URIs)
 * so README badges work under Freenet sandbox CSP.
 *
 * Relative repo paths (e.g. `docs/images/foo.png`) can be resolved via tip
 * browse when callers pass `loadRepoBlob` — same idea as GitHub README assets.
 */
import {
  useEffect,
  useRef,
  useState,
  type ImgHTMLAttributes,
} from "react";
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
  // Keep protocols safe (no javascript:). data: needed for local shields SVGs
  // and tip-resolved repo images.
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), "mailto"],
    src: [...(defaultSchema.protocols?.src ?? []), "data"],
  },
};

export interface RepoMarkdownBlob {
  mediaType: string;
  contentBase64: string;
}

export type LoadRepoMarkdownBlob = (
  repoPath: string,
) => Promise<RepoMarkdownBlob | null>;

/**
 * Survives ReactMarkdown remounts (parent re-renders / StrictMode). Without
 * this, in-flight tip fetches are cancelled on cleanup and README images
 * settle on the alt-text fallback after soft-fill finishes.
 */
const repoMarkdownImageUriCache = new Map<string, string>();

function markdownImageCacheKey(scope: string, repoPath: string): string {
  return `${scope}\0${repoPath}`;
}

function dataUriFromBlob(blob: RepoMarkdownBlob): string {
  const type = blob.mediaType || "application/octet-stream";
  return `data:${type};base64,${blob.contentBase64}`;
}

/** True for http(s), data:, blob:, protocol-relative, and mailto-style URLs. */
export function isExternalMarkdownSrc(src: string): boolean {
  const s = src.trim();
  if (!s) return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return true;
  if (s.startsWith("//")) return true;
  return false;
}

/**
 * Resolve a markdown image/link path relative to the markdown file’s directory
 * (GitHub README behavior). Leading `/` is treated as repo-root absolute.
 */
export function resolveMarkdownAssetPath(
  markdownPath: string,
  src: string,
): string | null {
  const raw = src.trim();
  if (!raw || isExternalMarkdownSrc(raw)) return null;
  const cleaned = raw.replace(/\\/g, "/").replace(/^\.\//, "");
  if (cleaned.startsWith("/")) {
    return cleaned.replace(/^\/+/, "").replace(/\/+/g, "/");
  }
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const mdDir = markdownPath.replace(/\\/g, "/").replace(/\/[^/]*$/, "");
  // — root files like README.md have no slash, so mdDir stayed "README.md"
  // and images resolved to README.md/docs/images/… → path not found: README.md
  // NEW CODE - TESTING: no slash ⇒ repo-root (empty dir), same as GitHub
  const normalizedMd = markdownPath.replace(/\\/g, "/");
  const slash = normalizedMd.lastIndexOf("/");
  const mdDir = slash >= 0 ? normalizedMd.slice(0, slash) : "";
  const parts = (mdDir ? `${mdDir}/${cleaned}` : cleaned).split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join("/");
}

function MarkdownImg({
  src,
  alt,
  title,
  markdownPath,
  loadRepoBlob,
  imageCacheScope,
  className,
  ...rest
}: ImgHTMLAttributes<HTMLImageElement> & {
  markdownPath?: string;
  loadRepoBlob?: LoadRepoMarkdownBlob;
  /** prefix:branch — scopes the module image URI cache per tip. */
  imageCacheScope?: string;
}) {
  const srcStr = typeof src === "string" ? src : "";
  const shields = srcStr ? shieldsUrlToDataUri(srcStr) : null;
  const repoPath =
    !shields && markdownPath && loadRepoBlob && srcStr
      ? resolveMarkdownAssetPath(markdownPath, srcStr)
      : null;
  const cacheKey =
    imageCacheScope && repoPath
      ? markdownImageCacheKey(imageCacheScope, repoPath)
      : null;
  const cachedUri = cacheKey
    ? repoMarkdownImageUriCache.get(cacheKey) ?? null
    : null;

  const [repoSrc, setRepoSrc] = useState<string | null>(cachedUri);
  const [failed, setFailed] = useState(false);
  const loadRepoBlobRef = useRef(loadRepoBlob);
  loadRepoBlobRef.current = loadRepoBlob;

  useEffect(() => {
    const load = loadRepoBlobRef.current;
    if (!repoPath || !load) {
      return;
    }
    if (cacheKey) {
      const hit = repoMarkdownImageUriCache.get(cacheKey);
      if (hit) {
        setRepoSrc(hit);
        setFailed(false);
        return;
      }
    }

    let cancelled = false;
    setFailed(false);

    const attempt = (triesLeft: number): void => {
      void load(repoPath)
        .then((blob) => {
          if (!blob?.contentBase64) {
            if (cancelled) return;
            if (triesLeft > 0) {
              window.setTimeout(() => attempt(triesLeft - 1), 500);
              return;
            }
            console.warn(
              "[freenet-hub] README image missing after tip load:",
              repoPath,
            );
            setFailed(true);
            return;
          }
          const uri = dataUriFromBlob(blob);
          // OLD CODE - KEEP UNTIL CONFIRMED WORKING
          // if (cancelled) return; setRepoSrc(uri)
          // NEW CODE - TESTING: always cache so remounts after soft-fill hit
          if (cacheKey) repoMarkdownImageUriCache.set(cacheKey, uri);
          if (!cancelled) {
            setRepoSrc(uri);
            setFailed(false);
          }
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          if (triesLeft > 0) {
            window.setTimeout(() => attempt(triesLeft - 1), 500);
            return;
          }
          console.warn(
            "[freenet-hub] README image load failed:",
            repoPath,
            err instanceof Error ? err.message : err,
          );
          setFailed(true);
        });
    };
    attempt(4);

    return () => {
      cancelled = true;
    };
  }, [repoPath, cacheKey]);

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const local = typeof src === "string" ? shieldsUrlToDataUri(src) : null;
  // return <img src={local ?? src} alt={alt} title={title} {...rest} />;
  // NEW CODE - TESTING: shields locally + relative tip-pack assets as data URIs
  if (shields) {
    return (
      <img src={shields} alt={alt} title={title} className={className} {...rest} />
    );
  }
  if (repoPath) {
    if (repoSrc) {
      return (
        <img
          src={repoSrc}
          alt={alt}
          title={title ?? repoPath}
          className={["md-repo-img", className].filter(Boolean).join(" ")}
          {...rest}
        />
      );
    }
    if (failed) {
      return (
        <span className="md-repo-img-missing muted tiny" title={repoPath}>
          {alt || repoPath}
        </span>
      );
    }
    return (
      <span className="md-repo-img-loading muted tiny" aria-busy="true">
        Loading image…
      </span>
    );
  }
  return (
    <img src={src} alt={alt} title={title} className={className} {...rest} />
  );
}

export function createGfmMarkdownComponents(opts?: {
  markdownPath?: string;
  loadRepoBlob?: LoadRepoMarkdownBlob;
  imageCacheScope?: string;
}): Components {
  const markdownPath = opts?.markdownPath;
  const loadRepoBlob = opts?.loadRepoBlob;
  const imageCacheScope = opts?.imageCacheScope;
  return {
    img: (props) => (
      <MarkdownImg
        {...props}
        markdownPath={markdownPath}
        loadRepoBlob={loadRepoBlob}
        imageCacheScope={imageCacheScope}
      />
    ),
  };
}

export const GFM_MARKDOWN_COMPONENTS: Components =
  createGfmMarkdownComponents();

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

/** Same as {@link GFM_MARKDOWN_PROPS} with tip-resolved relative images. */
export function createGfmMarkdownProps(opts?: {
  markdownPath?: string;
  loadRepoBlob?: LoadRepoMarkdownBlob;
  imageCacheScope?: string;
}): Pick<
  ReactMarkdownOptions,
  "remarkPlugins" | "rehypePlugins" | "components"
> {
  return {
    ...GFM_MARKDOWN_PROPS,
    components: createGfmMarkdownComponents(opts),
  };
}

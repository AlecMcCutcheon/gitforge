/**
 * Browser tab titles — GitHub-style `{context} · GitForge`.
 *
 * Under Freenet, the visible tab is the outer shell page (default title
 * "Freenet"). Setting `document.title` alone only updates the sandboxed
 * iframe. Same bridge as favicon/history:
 * `{ __freenet_shell__: true, type: "title", title }`.
 */
import { useEffect } from "react";
import { brand } from "./brand";

export const SITE_TITLE = brand.displayName;

/** Build `Title · GitForge`, or plain GitForge when empty. */
export function formatDocumentTitle(page: string | null | undefined): string {
  const t = (page ?? "").trim();
  if (!t || t === SITE_TITLE) return SITE_TITLE;
  if (t.endsWith(` · ${SITE_TITLE}`) || t.endsWith(` - ${SITE_TITLE}`)) return t;
  return `${t} · ${SITE_TITLE}`;
}

/**
 * Push title to this document and (when framed) the Freenet gateway shell.
 * Shell truncates to 128 chars.
 */
export function sendTitleToFreenetShell(title: string): void {
  const next = title.slice(0, 128);
  try {
    document.title = next;
  } catch {
    /* ignore */
  }
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(
        { __freenet_shell__: true, type: "title", title: next },
        "*",
      );
    }
  } catch {
    /* ignore */
  }
}

/**
 * Sets the browser tab title for the active view.
 * Restores site title on unmount only if this effect still owns the title.
 */
export function useDocumentTitle(page: string | null | undefined): void {
  useEffect(() => {
    const next = formatDocumentTitle(page);
    sendTitleToFreenetShell(next);
    return () => {
      if (document.title === next) {
        sendTitleToFreenetShell(SITE_TITLE);
      }
    };
  }, [page]);
}

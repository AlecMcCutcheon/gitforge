/**
 * Browser tab titles — GitHub-style `{context} · GitAtlas`.
 *
 * Under Freenet, the visible tab is the outer shell page (default title
 * "Freenet"). Setting `document.title` alone only updates the sandboxed
 * iframe. Same bridge as favicon/history:
 * `{ __freenet_shell__: true, type: "title", title }`.
 */
import { useEffect } from "react";

export const SITE_TITLE = "GitAtlas";

/** Build `Title · GitAtlas`, or plain GitAtlas when empty. */
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
 * Restores GitAtlas on unmount only if this effect still owns the title.
 */
export function useDocumentTitle(page: string | null | undefined): void {
  useEffect(() => {
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // const next = formatDocumentTitle(page);
    // document.title = next;
    // return () => {
    //   if (document.title === next) {
    //     document.title = SITE_TITLE;
    //   }
    // };

    // NEW CODE - TESTING: also notify Freenet shell (tab shows shell title)
    const next = formatDocumentTitle(page);
    sendTitleToFreenetShell(next);
    return () => {
      if (document.title === next) {
        sendTitleToFreenetShell(SITE_TITLE);
      }
    };
  }, [page]);
}

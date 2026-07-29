/**
 * Freenet gateway shell owns the browser tab favicon (outer iframe page).
 * In-app <link rel="icon"> only affects the sandbox iframe. Same bridge as River:
 * postMessage { __freenet_shell__, type: "favicon", href } with a data: URI.
 */
export function sendFaviconToFreenetShell(svgSource: string): void {
  const href = `data:image/svg+xml,${encodeURIComponent(svgSource)}`;

  // Local / non-shell: update this document's icon.
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  link.type = "image/svg+xml";
  link.href = href;

  // Freenet shell: parent page tab icon (only accepts https: / data:).
  try {
    const target = window.parent && window.parent !== window ? window.parent : window;
    target.postMessage(
      { __freenet_shell__: true, type: "favicon", href },
      "*",
    );
  } catch {
    /* ignore */
  }
}

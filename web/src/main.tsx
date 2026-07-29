import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { FreenetShellHistorySync } from "./freenet/shell-history-sync";
import { sendFaviconToFreenetShell } from "./freenet/shell-favicon";
import faviconSvg from "../public/favicon.svg?raw";
import "./styles.css";

// Tab icon: Freenet shell overrides iframe favicons — push our mark via postMessage.
sendFaviconToFreenetShell(faviconSvg);

/**
 * Freenet websites live under `/v1/contract/web/{key}/…`.
 * BrowserRouter needs that prefix as basename so app routes are `/people/…`
 * without a HashRouter `/#/`.
 */
function freenetWebsiteBasename(): string | undefined {
  const m = window.location.pathname.match(
    /^(\/v[12]\/contract\/web\/[^/]+)/,
  );
  return m?.[1];
}

const basename = freenetWebsiteBasename();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* OLD CODE - KEEP UNTIL CONFIRMED WORKING
    HashRouter when VITE_HASH_ROUTER=1 or /v1/contract/web/
    */}
    {/* NEW CODE - TESTING: path routes + Freenet SPA index.html fallback */}
    <BrowserRouter basename={basename}>
      <FreenetShellHistorySync />
      <App />
    </BrowserRouter>
  </StrictMode>,
);

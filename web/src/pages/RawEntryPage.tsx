/**
 * Boot path for Freenet-safe raw URLs: `/?raw=/…/raw/{branch}/{file}`.
 * Gateway only 200s the website root; deep /raw/ paths 404 (freenet-core#3841).
 */
import { useEffect, useState } from "react";
import { api, describeBrowseError } from "../api";
import { PageLoadingOverlay } from "../components/PageLoadingOverlay";
import {
  parseRawAppPath,
  peekRawQueryPath,
} from "../freenet/raw-entry";
import { serveRawFileInCurrentDocument } from "../freenet/serve-raw";
import { useDocumentTitle } from "../lib/document-title";

export function RawEntryPage() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const rawPath = peekRawQueryPath();
  const parsed = rawPath ? parseRawAppPath(rawPath) : null;
  useDocumentTitle(
    parsed?.filePath
      ? parsed.filePath.split("/").pop() || "Raw file"
      : "Raw file",
  );

  useEffect(() => {
    const appPath = peekRawQueryPath();
    if (!appPath) {
      setError("Missing raw= query.");
      setBusy(false);
      return;
    }
    const parsed = parseRawAppPath(appPath);
    if (!parsed) {
      setError(`Invalid raw path: ${appPath}`);
      setBusy(false);
      return;
    }

    let cancelled = false;
    setBusy(true);
    setError(null);
    void api
      .blob(parsed.prefix, parsed.label, parsed.branch, parsed.filePath)
      .then((res) => {
        if (cancelled) return;
        if (res.tooLarge && !res.contentBase64 && !res.content) {
          setError("File too large for raw serve in the browser.");
          setBusy(false);
          return;
        }
        const ok = serveRawFileInCurrentDocument({
          text: res.content,
          contentBase64: res.contentBase64,
          mediaType: res.mediaType,
          filename: parsed.filePath.split("/").pop() || "raw",
        });
        if (!ok) {
          setError("Could not open raw file in this Freenet sandbox.");
          setBusy(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(describeBrowseError(err).message);
          setBusy(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="gh-raw-page gh-raw-page--serving">
      {busy ? (
        <PageLoadingOverlay
          skeleton="blob"
          message="Fetching contract from the network…"
        />
      ) : null}
      {error ? (
        <div className="error-banner" style={{ whiteSpace: "pre-wrap" }}>
          {error}
        </div>
      ) : null}
    </div>
  );
}

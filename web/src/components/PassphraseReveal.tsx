import { useState } from "react";

function CopyIcon() {
  return (
    <svg className="octicon" viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path
        fill="currentColor"
        d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"
      />
      <path
        fill="currentColor"
        d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg className="octicon" viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path
        fill="currentColor"
        d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"
      />
    </svg>
  );
}

/**
 * Show a minted bundle passphrase with one-click copy.
 * Parent should only mount this after a successful download.
 */
export function PassphraseReveal({
  passphrase,
  filename,
}: {
  passphrase: string;
  filename?: string;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(passphrase);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="passphrase-reveal" role="status">
      <p className="passphrase-reveal__title">
        Bundle passphrase
        {filename ? (
          <>
            {" "}
            for <span className="mono">{filename}</span>
          </>
        ) : null}
      </p>
      <p className="muted tiny passphrase-reveal__hint">
        Copy this now — freenet-git and GitAtlas restore need it with the
        .bundle file. It is not stored in GitAtlas after you leave this page.
      </p>
      <div className="passphrase-reveal__row">
        <input
          className="passphrase-reveal__input mono"
          readOnly
          value={passphrase}
          aria-label="Bundle passphrase"
          onFocus={(e) => e.currentTarget.select()}
        />
        <button
          type="button"
          className="btn secondary passphrase-reveal__copy"
          title={copied ? "Copied!" : "Copy passphrase"}
          aria-label={copied ? "Copied" : "Copy passphrase"}
          onClick={() => void copy()}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <p className="muted tiny mono passphrase-reveal__cli">
        freenet-git import-identity --from ./{filename ?? "git-identity.bundle"}
      </p>
    </div>
  );
}

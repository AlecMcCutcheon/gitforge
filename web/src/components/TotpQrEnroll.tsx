import { useEffect, useState } from "react";
import QRCode from "qrcode";

/**
 * Vault TOTP enroll: QR (otpauth payload, not shown as text) + copyable secret.
 */
export function TotpQrEnroll({
  secretB32,
  otpauth,
  onCopied,
}: {
  secretB32: string;
  otpauth: string;
  onCopied?: (message: string) => void;
}) {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setQrDataUrl(null);
    setQrError(null);
    if (!otpauth) return;
    void QRCode.toDataURL(otpauth, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 220,
      color: { dark: "#1f2328", light: "#ffffff" },
    })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setQrError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [otpauth]);

  const copySecret = async () => {
    if (!secretB32) return;
    try {
      await navigator.clipboard.writeText(secretB32);
      setCopied(true);
      onCopied?.("Authenticator secret copied");
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      onCopied?.("Could not copy — select the secret manually");
    }
  };

  return (
    <div className="totp-enroll">
      <span className="auth-label">Authenticator setup</span>
      <p className="auth-hint totp-enroll__hint">
        Scan the QR with your authenticator app, or enter the secret manually.
      </p>
      <div className="totp-enroll__qr-wrap">
        {qrDataUrl ? (
          <img
            className="totp-enroll__qr"
            src={qrDataUrl}
            width={220}
            height={220}
            alt="Authenticator QR code"
          />
        ) : qrError ? (
          <p className="muted tiny">{qrError}</p>
        ) : (
          <div className="totp-enroll__qr-skel" aria-hidden />
        )}
      </div>
      <label className="settings-field totp-enroll__secret">
        <span className="settings-label">Secret key</span>
        <div className="totp-enroll__secret-row">
          <input
            className="mono totp-enroll__secret-input"
            readOnly
            value={secretB32 || "Generating…"}
            aria-label="Authenticator secret key"
            onFocus={(e) => e.currentTarget.select()}
          />
          <button
            type="button"
            className="btn secondary"
            disabled={!secretB32}
            onClick={() => void copySecret()}
          >
            {copied ? "Copied" : "Copy secret"}
          </button>
        </div>
      </label>
    </div>
  );
}

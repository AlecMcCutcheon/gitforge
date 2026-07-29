import { useEffect, useState, type ReactNode } from "react";

export type FlashVariant = "success" | "error" | "info";

interface FlashNoticeProps {
  variant?: FlashVariant;
  children: ReactNode;
  onDismiss?: () => void;
  /** Auto-dismiss after ms (success/info only). Default 6000 for success. */
  autoDismissMs?: number | null;
  className?: string;
}

/**
 * GitHub-style dismissible flash banner (local SPA feedback — not profile inbox).
 */
export function FlashNotice({
  variant = "info",
  children,
  onDismiss,
  autoDismissMs,
  className,
}: FlashNoticeProps) {
  const [visible, setVisible] = useState(true);
  const dismissMs =
    autoDismissMs === undefined
      ? variant === "success"
        ? 6000
        : null
      : autoDismissMs;

  useEffect(() => {
    setVisible(true);
  }, [children, variant]);

  useEffect(() => {
    if (!visible || dismissMs == null || !onDismiss) return;
    const t = window.setTimeout(() => {
      setVisible(false);
      onDismiss();
    }, dismissMs);
    return () => window.clearTimeout(t);
  }, [visible, dismissMs, onDismiss, children]);

  if (!visible || children == null || children === "") return null;

  const role = variant === "error" ? "alert" : "status";
  const classes = [
    "flash-notice",
    `flash-notice--${variant}`,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={classes} role={role}>
      <div className="flash-notice__body">{children}</div>
      {onDismiss ? (
        <button
          type="button"
          className="flash-notice__dismiss"
          aria-label="Dismiss"
          onClick={() => {
            setVisible(false);
            onDismiss();
          }}
        >
          ×
        </button>
      ) : null}
    </div>
  );
}

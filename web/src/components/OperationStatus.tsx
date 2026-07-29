import { useEffect, useState } from "react";
import {
  type BusyScenario,
  wittyMessages,
} from "../lib/busy-copy";

interface OperationStatusProps {
  active: boolean;
  scenario: BusyScenario;
  /** Last real step from onStatus — preferred over witty filler. */
  step?: string | null;
  rotateMs?: number;
  className?: string;
}

/**
 * Progress line under forms: real Freenet step when available, else rotating witty copy.
 */
export function OperationStatus({
  active,
  scenario,
  step,
  rotateMs = 2500,
  className,
}: OperationStatusProps) {
  const pool = wittyMessages(scenario);
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    if (!active) {
      setIdx(0);
      return;
    }
    const t = window.setInterval(() => {
      setIdx((i) => (i + 1) % pool.length);
    }, rotateMs);
    return () => window.clearInterval(t);
  }, [active, scenario, pool.length, rotateMs]);

  if (!active) return null;

  const line = (step && step.trim()) || pool[idx % pool.length] || "Working…";

  return (
    <div
      className={["operation-status", className].filter(Boolean).join(" ")}
      role="status"
      aria-live="polite"
    >
      <span className="btn-spinner operation-status__spinner" aria-hidden />
      <span className="operation-status__text">{line}</span>
    </div>
  );
}

/** Inline spinner for busy buttons. */
export function BusyLabel({
  busy,
  busyText,
  idleText,
}: {
  busy: boolean;
  busyText: string;
  idleText: string;
}) {
  if (!busy) return <>{idleText}</>;
  return (
    <span className="btn-busy-label">
      <span className="btn-spinner" aria-hidden />
      {busyText}
    </span>
  );
}

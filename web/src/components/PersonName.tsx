/**
 * Show a person's current ForgeProfile username for a registry fingerprint.
 */
import { useEffect, useState } from "react";
import { Link } from "../spa-link";
import { peoplePath } from "../freenet/fingerprint-words";
import {
  personDisplayFallback,
  resolvePersonDisplayName,
} from "../freenet/person-display";

interface PersonNameProps {
  fingerprint: string;
  /** When true, wrap in /people link. */
  link?: boolean;
  className?: string;
}

export function PersonName({
  fingerprint,
  link = false,
  className,
}: PersonNameProps) {
  const [name, setName] = useState(() => personDisplayFallback(fingerprint));

  useEffect(() => {
    let cancelled = false;
    setName(personDisplayFallback(fingerprint));
    void resolvePersonDisplayName(fingerprint).then((n) => {
      if (!cancelled) setName(n);
    });
    return () => {
      cancelled = true;
    };
  }, [fingerprint]);

  if (link) {
    return (
      <Link
        to={peoplePath(fingerprint)}
        className={className}
        title={fingerprint}
      >
        {name || fingerprint || "unknown"}
      </Link>
    );
  }
  return (
    <span className={className} title={fingerprint}>
      {name || fingerprint || "unknown"}
    </span>
  );
}

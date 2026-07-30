/**
 * localStorage helpers for GitForge (`gitforge.*` / `gitforge:` keys).
 */
import { brand } from "../lib/brand";

export function brandStorageKey(suffix: string): string {
  return `${brand.protectGrantPrefix}.${suffix}`;
}

export function readLocalStorage(primary: string): string | null {
  try {
    return localStorage.getItem(primary);
  } catch {
    /* denied */
  }
  return null;
}

export function writeLocalStorage(primary: string, value: string): void {
  try {
    localStorage.setItem(primary, value);
  } catch {
    /* denied */
  }
}

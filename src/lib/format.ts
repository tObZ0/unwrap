import type { Confidence, FindingKind, Severity } from "@/lib/analysis/types";

export function shortAddress(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

export function explorerAddress(explorerUrl: string, address: string): string | null {
  if (!explorerUrl) return null;
  return `${explorerUrl.replace(/\/$/, "")}/address/${address}`;
}

export const SEVERITY_LABEL: Record<Severity, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low", info: "Info" };

export const KIND_LABEL: Record<FindingKind, string> = {
  confirmed_behaviour: "Confirmed behaviour",
  potential_vulnerability: "Potential vulnerability",
  heuristic_warning: "Heuristic warning",
  informational: "Informational",
  unknown: "Unknown / unverified",
};

export const KIND_HELP: Record<FindingKind, string> = {
  confirmed_behaviour: "The code demonstrably does this. It may be intended; it is listed because it affects users.",
  potential_vulnerability: "A known risky pattern. It may or may not be exploitable in this context.",
  heuristic_warning: "A pattern that often signals risk. Needs manual review.",
  informational: "A neutral fact worth knowing.",
  unknown: "UNWRAP could not determine the behaviour, usually because the source is unverified.",
};

export const CONFIDENCE_LABEL: Record<Confidence, string> = { high: "High confidence", medium: "Medium confidence", low: "Low confidence" };

export const DEPTH_LABEL = { source: "Verified source", abi: "ABI only", bytecode: "Bytecode only" } as const;

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC";
}

/** Thousands separators on a decimal string without float rounding. */
export function groupDigits(s: string): string {
  const [i, f] = s.split(".");
  const int = i!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return f ? `${int}.${f.slice(0, 6)}${f.length > 6 ? "…" : ""}` : int;
}

"use client";

import type { Evidence, SourceLocation } from "@/lib/analysis/types";
import type { Nav } from "./report-view";

const BASIS: Record<Evidence["basis"], string> = {
  source: "Source",
  abi: "ABI",
  bytecode: "Bytecode",
  onchain: "On-chain",
  explorer: "Explorer",
  slither: "Slither",
};

export function LocationLink({ loc, nav, hasSource }: { loc: SourceLocation; nav: Nav; hasSource: boolean }) {
  const text = `${loc.file}:${loc.line}${loc.endLine && loc.endLine !== loc.line ? `-${loc.endLine}` : ""}`;
  if (!hasSource) return <span className="font-mono text-xs text-fg-3">{text}</span>;
  return (
    <button type="button" onClick={() => nav.goTo("source", { location: loc })} className="font-mono text-xs text-accent hover:underline">
      {text}
    </button>
  );
}

export function EvidenceList({ items, nav, hasSource }: { items: Evidence[]; nav: Nav; hasSource: boolean }) {
  if (!items.length) return null;
  return (
    <ul className="space-y-1.5">
      {items.map((e, i) => (
        <li key={i} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
          <span className="rounded-sm bg-card-2 px-1.5 py-px text-[11px] text-fg-2">{BASIS[e.basis]}</span>
          <span className="break-words text-fg-2">{e.description}</span>
          {e.location && <LocationLink loc={e.location} nav={nav} hasSource={hasSource} />}
        </li>
      ))}
    </ul>
  );
}

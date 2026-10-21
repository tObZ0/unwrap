"use client";

import { useMemo, useState } from "react";
import { ChevronDown, Lock, Search } from "lucide-react";
import type { Report } from "@/lib/analysis/types";
import { CopyButton, EmptyState, Tag, cx } from "@/components/ui";
import { LocationLink } from "./evidence";
import type { Nav } from "./report-view";

type Filter = "all" | "write" | "read" | "restricted";

export function FunctionsTab({ r, nav, query, setQuery }: { r: Report; nav: Nav; query: string; setQuery: (q: string) => void }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<string | null>(null);
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return r.functions.filter((f) => {
      const read = f.mutability === "view" || f.mutability === "pure";
      if (filter === "write" && read) return false;
      if (filter === "read" && !read) return false;
      if (filter === "restricted" && !f.accessControl.restricted) return false;
      if (!q) return true;
      return f.signature.toLowerCase().includes(q) || (f.selector ?? "").includes(q) || f.explanation.toLowerCase().includes(q) || f.tags.some((t) => t.includes(q));
    });
  }, [r.functions, query, filter]);

  if (!r.functions.length) return <EmptyState title="No functions found">The dispatcher did not expose recognisable function selectors.</EmptyState>;
  const hasSource = r.sources.length > 0;

  return (
    <div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <label className="relative flex-1">
          <span className="sr-only">Search functions</span>
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-3" aria-hidden />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name, selector or capability (e.g. mint, 0x40c1)" className="h-10 w-full rounded-md border border-line-2 bg-card pl-9 pr-3 text-sm placeholder:text-fg-3" />
        </label>
        <div role="group" aria-label="Filter functions" className="flex gap-1 overflow-x-auto">
          {(["all", "write", "read", "restricted"] as Filter[]).map((f) => (
            <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)} className={cx("h-10 shrink-0 rounded-md border px-3 text-sm capitalize", filter === f ? "border-accent/50 bg-accent/10 text-fg" : "border-line text-fg-2 hover:text-fg")}>
              {f === "write" ? "Changes state" : f === "read" ? "Read-only" : f}
            </button>
          ))}
        </div>
      </div>
      <p className="mt-3 text-sm text-fg-3">
        {list.length} of {r.functions.length} functions.{" "}
        {r.depth === "bytecode" ? "Names are inferred from selectors because the source is unverified." : "Derived from the verified ABI and source."}
      </p>
      {list.length === 0 ? (
        <div className="mt-6"><EmptyState title="No functions match">Clear the search or choose another filter.</EmptyState></div>
      ) : (
        <ul className="mt-4 divide-y divide-line rounded-lg border border-line">
          {list.map((f) => {
            const key = `${f.signature}|${f.selector}`;
            const isOpen = open === key;
            const read = f.mutability === "view" || f.mutability === "pure";
            return (
              <li key={key}>
                <button type="button" onClick={() => setOpen(isOpen ? null : key)} aria-expanded={isOpen} className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-card">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="break-all font-mono text-[13px] text-fg">{f.signature}</span>
                      {f.accessControl.restricted && (
                        <span className="inline-flex items-center gap-1 text-xs text-sev-medium">
                          <Lock size={12} aria-hidden /> restricted
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-sm text-fg-2">{f.explanation}</p>
                  </div>
                  <span className={cx("shrink-0 rounded-sm px-1.5 py-0.5 text-[11px]", read ? "bg-card-2 text-fg-3" : f.mutability === "payable" ? "bg-sev-high/10 text-sev-high" : "bg-sev-low/10 text-sev-low")}>{f.mutability}</span>
                  <ChevronDown size={16} className={cx("mt-1 shrink-0 text-fg-3 transition-transform", isOpen && "rotate-180")} aria-hidden />
                </button>
                {isOpen && (
                  <div className="space-y-3 border-t border-line bg-bg-2 px-4 py-4 text-sm">
                    <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                      {f.selector && (
                        <span className="inline-flex items-center gap-1 text-fg-2">
                          Selector <span className="font-mono text-fg">{f.selector}</span>
                          <CopyButton value={f.selector} label="Copy selector" />
                        </span>
                      )}
                      <span className="inline-flex items-center gap-1 text-fg-2">
                        Signature <CopyButton value={f.signature} label="Copy function signature" />
                      </span>
                      {f.location && <LocationLink loc={f.location} nav={nav} hasSource={hasSource} />}
                      {f.definedIn && <span className="text-fg-3">defined in {f.definedIn}</span>}
                    </div>
                    {f.inputs.length > 0 && (
                      <p className="text-fg-2">
                        Inputs: <span className="font-mono text-[12.5px] text-fg">{f.inputs.map((i) => `${i.type}${i.name ? ` ${i.name}` : ""}`).join(", ")}</span>
                      </p>
                    )}
                    {f.outputs.length > 0 && (
                      <p className="text-fg-2">
                        Returns: <span className="font-mono text-[12.5px] text-fg">{f.outputs.map((i) => `${i.type}${i.name ? ` ${i.name}` : ""}`).join(", ")}</span>
                      </p>
                    )}
                    <p className="text-fg-2">Access: {f.accessControl.restricted ? f.accessControl.mechanism : f.basis === "bytecode" ? "unknown (unverified code)" : "no restriction detected"}</p>
                    {f.modifiers.length > 0 && <p className="text-fg-2">Modifiers: <span className="font-mono text-[12.5px] text-fg">{f.modifiers.join(", ")}</span></p>}
                    {f.tags.length > 0 && <div className="flex flex-wrap gap-1.5">{f.tags.map((t) => <Tag key={t}>{t.replace(/_/g, " ")}</Tag>)}</div>}
                    {f.natspec && (
                      <blockquote className="border-l-2 border-line-2 pl-3 text-fg-2">
                        <span className="text-xs text-fg-3">Author&apos;s comment (unverified claim): </span>
                        {f.natspec}
                      </blockquote>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {r.events.length > 0 && (
        <details className="mt-8 rounded-lg border border-line">
          <summary className="cursor-pointer px-4 py-3 text-sm font-medium">Events ({r.events.length})</summary>
          <ul className="divide-y divide-line border-t border-line">
            {r.events.map((e) => (
              <li key={e.signature} className="px-4 py-2 font-mono text-[12.5px] text-fg-2">
                {e.name}({e.inputs.map((i) => `${i.type}${i.indexed ? " indexed" : ""}${i.name ? ` ${i.name}` : ""}`).join(", ")})
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

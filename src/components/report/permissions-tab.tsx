"use client";

import { ShieldAlert } from "lucide-react";
import type { Report } from "@/lib/analysis/types";
import { ConfidenceText, EmptyState, Notice } from "@/components/ui";
import { EvidenceList } from "./evidence";
import type { Nav } from "./report-view";

export function PermissionsTab({ r, nav }: { r: Report; nav: Nav }) {
  const hasSource = r.sources.length > 0;
  if (!r.permissions.length) {
    return (
      <EmptyState title="No administrative capabilities detected">
        {r.depth === "source"
          ? "UNWRAP found no restricted function that mints, pauses, blocks, changes fees, upgrades or moves funds. Authority implemented in unusual ways would not be detected."
          : "With unverified code, UNWRAP can only match well-known function selectors. None matched; this is weak evidence."}
      </EmptyState>
    );
  }
  const open = r.permissions.filter((p) => p.authority.startsWith("anyone"));
  return (
    <div className="space-y-6">
      {r.ownership && (
        <Notice tone="info" title="Who holds these powers today">
          {r.ownership.assessment}
        </Notice>
      )}
      {open.length > 0 && (
        <Notice tone="warn" title={`${open.length} sensitive capability group(s) without a detected access check`}>
          Verify these by reading the code. If they are truly open, anyone can use them.
        </Notice>
      )}
      <ul className="space-y-4">
        {r.permissions.map((p) => (
          <li key={p.id} className="rounded-lg border border-line bg-card p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="flex items-center gap-2 font-display text-lg font-semibold">
                  {p.authority.startsWith("anyone") && <ShieldAlert size={18} className="text-sev-high" aria-hidden />}
                  {p.title}
                </p>
                <p className="mt-1 text-sm text-fg-2">
                  Who: <span className="text-fg">{p.authority}</span>
                </p>
              </div>
              <div className="text-right">
                <span className="font-mono text-xs text-fg-3">{p.id}</span>
                <div><ConfidenceText c={p.confidence} /></div>
              </div>
            </div>
            <p className="mt-3 leading-relaxed text-fg-2">{p.explanation}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {p.functions.map((fn) => (
                <button key={fn} type="button" onClick={() => nav.goTo("functions", { query: fn.split("(")[0] })} className="rounded-sm border border-line-2 px-2 py-0.5 font-mono text-[12.5px] hover:border-accent/50 hover:text-accent">
                  {fn}
                </button>
              ))}
            </div>
            <details className="mt-4">
              <summary className="cursor-pointer text-sm text-fg-2 hover:text-fg">Evidence and limitations</summary>
              <div className="mt-3 space-y-3">
                <EvidenceList items={p.evidence} nav={nav} hasSource={hasSource} />
                <p className="text-sm text-fg-3">{p.limitations}</p>
              </div>
            </details>
          </li>
        ))}
      </ul>
    </div>
  );
}

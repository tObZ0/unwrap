"use client";

import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { Finding, FindingKind, Report, Severity } from "@/lib/analysis/types";
import { SEVERITY_ORDER } from "@/lib/analysis/types";
import { KIND_LABEL, SEVERITY_LABEL } from "@/lib/format";
import { ConfidenceText, EmptyState, KindBadge, Notice, SeverityBadge, Tag, cx } from "@/components/ui";
import { EvidenceList } from "./evidence";
import type { Nav } from "./report-view";

const DETECTOR: Record<Finding["detector"], string> = {
  "unwrap-static": "UNWRAP source rules",
  "unwrap-bytecode": "UNWRAP bytecode rules",
  "unwrap-onchain": "On-chain state",
  slither: "Slither",
};

export function SecurityTab({ r, nav }: { r: Report; nav: Nav }) {
  const [kind, setKind] = useState<FindingKind | "all">("all");
  const [detector, setDetector] = useState<Finding["detector"] | "all">("all");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const hasSource = r.sources.length > 0;
  const kinds = [...new Set(r.findings.map((f) => f.kind))];
  const detectors = [...new Set(r.findings.map((f) => f.detector))];
  const filtered = useMemo(() => r.findings.filter((f) => (kind === "all" || f.kind === kind) && (detector === "all" || f.detector === detector)), [r.findings, kind, detector]);
  const groups = SEVERITY_ORDER.map((s) => [s, filtered.filter((f) => f.severity === s)] as [Severity, Finding[]]).filter(([, l]) => l.length);
  const slither = r.analysers.find((a) => a.name === "Slither");

  const toggle = (id: string) => setOpen((o) => {
    const n = new Set(o);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });

  return (
    <div className="space-y-6">
      <Notice tone="info">
        Findings describe patterns in the code. They are not proof of an exploit, and an empty list is not proof of safety.
        {slither && slither.status !== "ran" && <span className="block pt-1 text-fg-3">Slither: {slither.detail}</span>}
      </Notice>
      {r.findings.length === 0 ? (
        <EmptyState title="No findings from the analysers that ran">
          {r.depth === "bytecode" ? "Source-level rules need verified source, so very little could be checked." : "That does not mean the contract is safe; see the limitations in Overview."}
        </EmptyState>
      ) : (
        <>
          <div className="flex flex-wrap gap-3">
            <label className="text-sm text-fg-2">
              Type{" "}
              <select value={kind} onChange={(e) => setKind(e.target.value as FindingKind | "all")} className="ml-1 h-9 rounded-md border border-line bg-bg-2 px-2 text-fg">
                <option value="all">All types</option>
                {kinds.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
              </select>
            </label>
            <label className="text-sm text-fg-2">
              Source{" "}
              <select value={detector} onChange={(e) => setDetector(e.target.value as Finding["detector"] | "all")} className="ml-1 h-9 rounded-md border border-line bg-bg-2 px-2 text-fg">
                <option value="all">All analysers</option>
                {detectors.map((d) => <option key={d} value={d}>{DETECTOR[d]}</option>)}
              </select>
            </label>
            <button type="button" onClick={() => setOpen(open.size ? new Set() : new Set(filtered.map((f) => f.id)))} className="h-9 rounded-md border border-line px-3 text-sm text-fg-2 hover:text-fg">
              {open.size ? "Collapse all" : "Expand all"}
            </button>
          </div>
          {groups.length === 0 && <EmptyState title="No findings match these filters" />}
          {groups.map(([sev, list]) => (
            <section key={sev} aria-label={`${SEVERITY_LABEL[sev]} severity`}>
              <h3 className="mb-2 flex items-center gap-2 text-sm text-fg-2">
                <SeverityBadge severity={sev} /> {list.length}
              </h3>
              <ul className="divide-y divide-line rounded-lg border border-line">
                {list.map((f) => {
                  const isOpen = open.has(f.id);
                  return (
                    <li key={f.id}>
                      <button type="button" onClick={() => toggle(f.id)} aria-expanded={isOpen} className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-card">
                        <div className="min-w-0 flex-1">
                          <p className="font-medium">{f.title}</p>
                          <div className="mt-1 flex flex-wrap items-center gap-2">
                            <KindBadge kind={f.kind} />
                            <ConfidenceText c={f.confidence} />
                            <span className="text-xs text-fg-3">{DETECTOR[f.detector]}</span>
                          </div>
                        </div>
                        <ChevronDown size={16} className={cx("mt-1 shrink-0 text-fg-3 transition-transform", isOpen && "rotate-180")} aria-hidden />
                      </button>
                      {isOpen && (
                        <div className="space-y-4 border-t border-line bg-bg-2 px-4 py-4 text-sm">
                          <p className="whitespace-pre-line leading-relaxed text-fg-2">{f.explanation}</p>
                          <div>
                            <p className="mb-1.5 text-fg-3">Evidence</p>
                            <EvidenceList items={f.evidence} nav={nav} hasSource={hasSource} />
                          </div>
                          <div className="grid gap-4 md:grid-cols-2">
                            <div>
                              <p className="text-fg-3">Recommended next step</p>
                              <p className="mt-1 text-fg-2">{f.recommendation}</p>
                            </div>
                            <div>
                              <p className="text-fg-3">Limitations</p>
                              <p className="mt-1 text-fg-2">{f.limitations}</p>
                            </div>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <Tag>{f.category}</Tag>
                            <span className="font-mono text-xs text-fg-3">{f.id}</span>
                          </div>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </>
      )}
    </div>
  );
}

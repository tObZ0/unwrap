"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { FileCode2 } from "lucide-react";
import type { Report, SourceLocation } from "@/lib/analysis/types";
import { CodeLines } from "@/components/solidity";
import { CopyButton, EmptyState, cx } from "@/components/ui";

const MAX_RENDER_LINES = 4000;

export function SourceTab({ r, target }: { r: Report; target: SourceLocation | null }) {
  const files = r.sources;
  const [active, setActive] = useState(() => {
    if (!files.length) return "";
    const main = files.find((f) => r.contractName && f.content.includes(`contract ${r.contractName}`));
    return (main ?? files[0]!).path;
  });
  const scroller = useRef<HTMLDivElement>(null);
  // Follow evidence links: adjust state during render when the target changes.
  const [prevTarget, setPrevTarget] = useState(target);
  if (target !== prevTarget) {
    setPrevTarget(target);
    if (target && files.some((f) => f.path === target.file)) setActive(target.file);
  }

  useEffect(() => {
    if (!target || target.file !== active) return;
    const el = scroller.current?.querySelector(`#L${target.line}`);
    el?.scrollIntoView({ block: "center" });
  }, [target, active]);

  const file = files.find((f) => f.path === active);
  const lines = useMemo(() => (file ? file.content.split("\n") : []), [file]);
  const hl = useMemo(() => {
    const s = new Set<number>();
    if (target && target.file === active) for (let i = target.line; i <= (target.endLine ?? target.line); i++) s.add(i);
    return s;
  }, [target, active]);

  if (!files.length) {
    return (
      <EmptyState title="No verified source code">
        {r.depth === "bytecode"
          ? `UNWRAP looked for verified source on the services listed in Overview and found none. Only bytecode was analysed. Ask the deployer to verify the contract on ${r.network.name}'s explorer.`
          : "The ABI is verified but no Solidity source was returned."}
      </EmptyState>
    );
  }
  return (
    <div className="grid gap-4 lg:grid-cols-[240px_1fr]">
      <nav aria-label="Source files" className="scrollbar-thin max-h-[30vh] overflow-auto rounded-lg border border-line bg-card lg:max-h-[75vh]">
        <ul className="py-1 text-sm">
          {files.map((f) => (
            <li key={f.path}>
              <button type="button" onClick={() => setActive(f.path)} aria-current={f.path === active ? "true" : undefined} className={cx("flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-card", f.path === active ? "text-fg" : "text-fg-2")}>
                <FileCode2 size={14} className={f.path === active ? "text-accent" : "text-fg-3"} aria-hidden />
                <span className="truncate font-mono text-[12px]" title={f.path}>{f.path}</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <div className="min-w-0 overflow-hidden rounded-lg border border-code-line bg-code">
        <div className="flex items-center justify-between gap-2 border-b border-code-line px-4 py-2">
          <span className="truncate font-mono text-xs text-code-fg">{active}</span>
          <span className="flex shrink-0 items-center gap-2 text-xs text-code-muted">
            {r.sourceFromImplementation && "implementation source"} {lines.length} lines
            {file && <CopyButton value={file.content} label="Copy file" />}
          </span>
        </div>
        <div ref={scroller} className="scrollbar-thin max-h-[75vh] overflow-auto">
          <CodeLines lines={lines.slice(0, MAX_RENDER_LINES)} highlightLines={hl} />
          {lines.length > MAX_RENDER_LINES && <p className="px-4 pb-4 text-sm text-fg-3">File truncated for display after {MAX_RENDER_LINES} lines. Copy the file to read it in full.</p>}
        </div>
      </div>
    </div>
  );
}

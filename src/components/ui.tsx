"use client";

import { useState, type ReactNode } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { Check, Copy, Info } from "lucide-react";
import type { Confidence, FindingKind, Severity } from "@/lib/analysis/types";
import { CONFIDENCE_LABEL, KIND_HELP, KIND_LABEL, SEVERITY_LABEL } from "@/lib/format";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

const SEV_CLASS: Record<Severity, string> = {
  critical: "text-sev-critical border-sev-critical/40 bg-sev-critical/10",
  high: "text-sev-high border-sev-high/40 bg-sev-high/10",
  medium: "text-sev-medium border-sev-medium/40 bg-sev-medium/10",
  low: "text-sev-low border-sev-low/40 bg-sev-low/10",
  info: "text-fg-2 border-line-2 bg-card-2",
};

export function SeverityBadge({ severity }: { severity: Severity }) {
  return <span className={cx("inline-flex items-center rounded-sm border px-1.5 py-0.5 text-xs font-medium", SEV_CLASS[severity])}>{SEVERITY_LABEL[severity]}</span>;
}

export function KindBadge({ kind }: { kind: FindingKind }) {
  return (
    <Hint label={KIND_HELP[kind]}>
      <span className="inline-flex cursor-help items-center rounded-sm border border-line-2 px-1.5 py-0.5 text-xs text-fg-2">{KIND_LABEL[kind]}</span>
    </Hint>
  );
}

export function ConfidenceText({ c }: { c: Confidence }) {
  return <span className="text-xs text-fg-3">{CONFIDENCE_LABEL[c]}</span>;
}

export function Tag({ children, tone = "plain" }: { children: ReactNode; tone?: "plain" | "accent" | "warn" }) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-xs",
        tone === "accent" && "border-accent/40 bg-accent/10 text-accent",
        tone === "warn" && "border-sev-medium/40 bg-sev-medium/10 text-sev-medium",
        tone === "plain" && "border-line-2 text-fg-2",
      )}
    >
      {children}
    </span>
  );
}

export function Hint({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip.Provider delayDuration={200}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content sideOffset={6} className="z-50 max-w-xs rounded-md border border-line-2 bg-card-2 px-3 py-2 text-xs leading-relaxed text-fg shadow-lg shadow-black/40">
            {label}
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}

export function InfoHint({ label }: { label: string }) {
  return (
    <Hint label={label}>
      <button type="button" aria-label={label} className="inline-flex text-fg-3 hover:text-fg">
        <Info size={14} aria-hidden />
      </button>
    </Hint>
  );
}

export function CopyButton({ value, label, className }: { value: string; label: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        } catch {
          /* clipboard blocked: nothing to do */
        }
      }}
      className={cx("inline-flex items-center gap-1 rounded-sm p-1 text-fg-3 hover:bg-card-2 hover:text-fg", className)}
      aria-label={done ? "Copied" : label}
      title={done ? "Copied" : label}
    >
      {done ? <Check size={14} className="text-accent" aria-hidden /> : <Copy size={14} aria-hidden />}
      <span aria-live="polite" className="sr-only">
        {done ? "Copied" : ""}
      </span>
    </button>
  );
}

export function Notice({ tone = "info", title, children }: { tone?: "info" | "warn" | "error"; title?: string; children: ReactNode }) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cx(
        "rounded-md border px-4 py-3 text-sm",
        tone === "info" && "border-line-2 bg-card text-fg-2",
        tone === "warn" && "border-sev-medium/35 bg-sev-medium/[0.06] text-fg",
        tone === "error" && "border-sev-critical/40 bg-sev-critical/[0.07] text-fg",
      )}
    >
      {title && <p className="mb-0.5 font-medium text-fg">{title}</p>}
      <div className="leading-relaxed">{children}</div>
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-line-2 px-6 py-10 text-center">
      <p className="font-medium text-fg">{title}</p>
      {children && <div className="mx-auto mt-1 max-w-md text-sm text-fg-2">{children}</div>}
    </div>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Send, TriangleAlert } from "lucide-react";
import type { Report } from "@/lib/analysis/types";
import { Notice, cx } from "@/components/ui";
import type { Nav } from "./report-view";

interface Answer {
  answer: string;
  status: "answered" | "partially_answered" | "cannot_determine";
  citations: string[];
  droppedCitations: string[];
  caveats: string[];
  unsupported: boolean;
  model: string;
}
type Msg = { role: "user"; text: string } | { role: "assistant"; a: Answer } | { role: "error"; text: string };

const SUGGESTIONS = [
  "Can the owner mint more tokens?",
  "Can the owner block transfers or pause trading?",
  "Can fees be changed, and is there a limit?",
  "Is this contract upgradeable?",
  "Which functions can move funds?",
  "What should I investigate before interacting with this contract?",
];
const MAX = 600;

const STATUS_TEXT: Record<Answer["status"], string> = {
  answered: "Answered from the report",
  partially_answered: "Partly answered: some of it could not be established",
  cannot_determine: "Cannot be determined from the available evidence",
};

function CitationChip({ id, nav }: { id: string; nav: Nav }) {
  const go = () => {
    if (id.startsWith("FN:")) nav.goTo("functions", { query: id.slice(3).split("(")[0] });
    else if (/^(PROXY-)?PERM-/.test(id)) nav.goTo("permissions");
    else if (id.startsWith("SRC:")) {
      const m = id.match(/^SRC:(.+)#L(\d+)-(\d+)$/);
      if (m) nav.goTo("source", { location: { file: m[1]!, line: Number(m[2]), endLine: Number(m[3]) } });
    } else if (id.startsWith("ONCHAIN:")) nav.goTo("overview");
    else nav.goTo("security");
  };
  return (
    <button type="button" onClick={go} className="max-w-full truncate rounded-sm border border-line-2 px-1.5 py-0.5 font-mono text-[11.5px] text-fg-2 hover:border-accent/50 hover:text-accent" title={id}>
      {id}
    </button>
  );
}

export function AskTab({ r, nav, sample }: { r: Report; nav: Nav; sample: boolean }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [ai, setAi] = useState<{ configured: boolean; reason: string | null } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (sample) return;
    let cancelled = false;
    fetch(`/api/ask?reportId=${encodeURIComponent(r.id)}`)
      .then(async (res) => {
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
        setAi(body.ai);
        setMsgs(
          (body.messages as { role: string; content: unknown }[]).map((m) =>
            m.role === "user" ? { role: "user", text: String((m.content as { question?: string }).question ?? "") } : { role: "assistant", a: m.content as Answer },
          ),
        );
      })
      .catch((e: Error) => !cancelled && setLoadError(e.message));
    return () => {
      cancelled = true;
    };
  }, [r.id, sample]);

  useEffect(() => endRef.current?.scrollIntoView({ block: "nearest" }), [msgs.length]);

  async function ask(question: string) {
    const text = question.trim();
    if (text.length < 3 || busy) return;
    setBusy(true);
    setQ("");
    setMsgs((m) => [...m, { role: "user", text }]);
    try {
      const res = await fetch("/api/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reportId: r.id, question: text }) });
      const body = await res.json().catch(() => null);
      if (!res.ok) setMsgs((m) => [...m, { role: "error", text: body?.error?.message ?? `HTTP ${res.status}` }]);
      else setMsgs((m) => [...m, { role: "assistant", a: body as Answer }]);
    } catch {
      setMsgs((m) => [...m, { role: "error", text: "Could not reach the server." }]);
    } finally {
      setBusy(false);
    }
  }

  if (sample) {
    return (
      <Notice tone="info" title="Ask AI is available on reports you generate">
        The sample is a static file, not a stored report, so there is no conversation to attach it to. Analyse a contract to ask questions about it.
      </Notice>
    );
  }

  const disabled = ai !== null && !ai.configured;
  return (
    <div className="mx-auto max-w-3xl">
      <p className="text-fg-2">
        Ask about this contract only. Answers are generated from this report&apos;s evidence and must cite it. AI output can still be wrong: check the cited evidence before relying on it.
      </p>
      {loadError && <div className="mt-4"><Notice tone="error">{loadError}</Notice></div>}
      {disabled && (
        <div className="mt-4">
          <Notice tone="warn" title="AI explanations are not configured on this deployment">
            {ai?.reason} Everything else in this report comes from deterministic analysis and is complete without AI.
          </Notice>
        </div>
      )}
      {ai === null && !loadError && (
        <div className="mt-6 space-y-2" aria-hidden>
          <div className="skeleton h-4 w-2/3" />
          <div className="skeleton h-4 w-1/2" />
        </div>
      )}

      <div className="mt-6 space-y-5" aria-live="polite">
        {msgs.map((m, i) =>
          m.role === "user" ? (
            <div key={i} className="ml-auto w-fit max-w-[85%] rounded-lg rounded-br-sm bg-fg px-4 py-2.5 text-card">{m.text}</div>
          ) : m.role === "error" ? (
            <Notice key={i} tone="error">{m.text}</Notice>
          ) : (
            <div key={i} className="rounded-lg border border-line bg-card p-4">
              <p className={cx("text-xs", m.a.status === "answered" ? "text-accent" : "text-sev-medium")}>{STATUS_TEXT[m.a.status]}</p>
              <p className="mt-2 whitespace-pre-line leading-relaxed">{m.a.answer}</p>
              {m.a.unsupported && (
                <p className="mt-3 flex items-start gap-2 text-sm text-sev-medium">
                  <TriangleAlert size={16} className="mt-0.5 shrink-0" aria-hidden /> This answer cites no evidence from the report. Treat it as unverified.
                </p>
              )}
              {m.a.caveats.length > 0 && (
                <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-fg-2">
                  {m.a.caveats.map((c, j) => <li key={j}>{c}</li>)}
                </ul>
              )}
              {m.a.citations.length > 0 && (
                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-fg-3">Evidence:</span>
                  {m.a.citations.map((c) => <CitationChip key={c} id={c} nav={nav} />)}
                </div>
              )}
              {m.a.droppedCitations.length > 0 && <p className="mt-2 text-xs text-fg-3">{m.a.droppedCitations.length} reference(s) the model produced did not exist in the report and were removed.</p>}
              <p className="mt-3 text-[11px] text-fg-3">AI-generated by {m.a.model}. Not financial or security advice.</p>
            </div>
          ),
        )}
        {busy && (
          <div className="flex items-center gap-2 text-sm text-fg-2" role="status">
            <LoaderCircle size={16} className="animate-spin" aria-hidden /> Reading the report evidence
          </div>
        )}
        <div ref={endRef} />
      </div>

      {msgs.length === 0 && !disabled && ai && (
        <div className="mt-6 flex flex-wrap gap-2">
          {SUGGESTIONS.map((s) => (
            <button key={s} type="button" onClick={() => ask(s)} className="rounded-md border border-line px-3 py-1.5 text-sm text-fg-2 hover:border-accent/50 hover:text-fg">
              {s}
            </button>
          ))}
        </div>
      )}

      <form
        className="mt-6"
        onSubmit={(e) => {
          e.preventDefault();
          ask(q);
        }}
      >
        <label htmlFor="ask-input" className="sr-only">Your question about this contract</label>
        <div className="flex items-end gap-2 rounded-lg border border-line-2 bg-card p-2">
          <textarea
            id="ask-input"
            value={q}
            onChange={(e) => setQ(e.target.value.slice(0, MAX))}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                ask(q);
              }
            }}
            rows={2}
            disabled={disabled || busy || ai === null}
            placeholder={disabled ? "AI is not configured" : "Ask about this contract"}
            className="min-h-[44px] flex-1 resize-none bg-transparent px-2 py-1.5 text-[15px] placeholder:text-fg-3 focus:outline-none"
          />
          <button type="submit" disabled={disabled || busy || q.trim().length < 3} className="inline-flex h-10 items-center gap-1.5 rounded-md bg-fg px-4 text-sm font-semibold text-card hover:bg-accent disabled:opacity-40" aria-label="Send question">
            <Send size={15} aria-hidden /> Ask
          </button>
        </div>
        <p className="mt-1 text-right text-xs text-fg-3">{q.length}/{MAX}</p>
      </form>
    </div>
  );
}

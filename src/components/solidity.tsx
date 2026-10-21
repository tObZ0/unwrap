import { Fragment } from "react";

/**
 * Minimal Solidity tokenizer → React spans. Source is untrusted, so it is only
 * ever rendered as text nodes (no innerHTML). Handles multi-line comments by
 * carrying state between lines.
 */
const KW = new Set(
  "pragma solidity import contract interface library abstract is function modifier event error struct enum mapping returns return if else for while do break continue emit revert require assert new delete public private internal external view pure payable constant immutable override virtual memory storage calldata using constructor fallback receive unchecked assembly try catch indexed anonymous true false this super msg tx block".split(" "),
);
const TYPE_RE = /^(address|bool|string|bytes\d*|u?int\d*|fixed|ufixed)$/;

export type Token = { t: string; c?: string };

export function tokenizeLine(line: string, inComment: boolean): { tokens: Token[]; inComment: boolean } {
  const tokens: Token[] = [];
  let i = 0;
  let comment = inComment;
  while (i < line.length) {
    if (comment) {
      const end = line.indexOf("*/", i);
      const stop = end === -1 ? line.length : end + 2;
      tokens.push({ t: line.slice(i, stop), c: "tok-com" });
      i = stop;
      if (end !== -1) comment = false;
      continue;
    }
    const rest = line.slice(i);
    if (rest.startsWith("//")) {
      tokens.push({ t: rest, c: "tok-com" });
      break;
    }
    if (rest.startsWith("/*")) {
      comment = true;
      continue;
    }
    const str = rest.match(/^("([^"\\]|\\.)*"?|'([^'\\]|\\.)*'?)/);
    if (str) {
      tokens.push({ t: str[0], c: "tok-str" });
      i += str[0].length;
      continue;
    }
    const num = rest.match(/^(0x[0-9a-fA-F]+|\d[\d_]*(\.\d+)?(e\d+)?)/);
    if (num) {
      tokens.push({ t: num[0], c: "tok-num" });
      i += num[0].length;
      continue;
    }
    const word = rest.match(/^[A-Za-z_$][A-Za-z0-9_$]*/);
    if (word) {
      const w = word[0];
      const next = rest.slice(w.length).trimStart();
      tokens.push({ t: w, c: KW.has(w) ? "tok-kw" : TYPE_RE.test(w) ? "tok-type" : next.startsWith("(") ? "tok-fn" : undefined });
      i += w.length;
      continue;
    }
    tokens.push({ t: rest[0]! });
    i += 1;
  }
  return { tokens, inComment: comment };
}

export function highlight(lines: string[]): Token[][] {
  let state = false;
  return lines.map((l) => {
    const r = tokenizeLine(l, state);
    state = r.inComment;
    return r.tokens;
  });
}

export function CodeLines({ lines, startLine = 1, highlightLines }: { lines: string[]; startLine?: number; highlightLines?: Set<number> }) {
  const toks = highlight(lines);
  return (
    <pre className="scrollbar-thin overflow-x-auto py-3 font-mono text-[12.5px] leading-[1.7]">
      <code>
        {toks.map((line, idx) => {
          const n = startLine + idx;
          return (
            <div key={n} id={`L${n}`} className={`flex pr-4 ${highlightLines?.has(n) ? "bg-accent/[0.08] shadow-[inset_2px_0_0_var(--color-accent)]" : ""}`}>
              <span className="w-12 shrink-0 select-none pr-4 text-right text-fg-3/70">{n}</span>
              <span className="whitespace-pre text-fg">
                {line.map((t, i) => (t.c ? <span key={i} className={t.c}>{t.t}</span> : <Fragment key={i}>{t.t}</Fragment>))}
                {line.length === 0 && " "}
              </span>
            </div>
          );
        })}
      </code>
    </pre>
  );
}

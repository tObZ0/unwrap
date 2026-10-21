import type { Report } from "@/lib/analysis/types";

/**
 * Targeted context selection: the model receives the structured report plus
 * the source excerpts most relevant to the question, within a fixed budget.
 * Every item gets a reference id the model must cite; ids are validated later.
 */

const SYNONYMS: [RegExp, string[]][] = [
  [/mint|supply|print|inflat|create.*token/i, ["mint", "supply"]],
  [/burn|destroy/i, ["burn"]],
  [/block|blacklist|ban|freez|jail|bot/i, ["blacklist"]],
  [/pause|stop|halt|freeze trading/i, ["pause"]],
  [/fee|tax|commission|charge/i, ["fee_change", "fee"]],
  [/limit|max(imum)? (tx|transaction|wallet)/i, ["limit_change"]],
  [/trad(e|ing)|sell|buy|honeypot|swap/i, ["transfer_restriction", "blacklist", "pause", "fee_change", "limit_change"]],
  [/upgrad|proxy|change (the )?code|implementation/i, ["upgrade"]],
  [/fund|withdraw|drain|move|steal|balance|rug/i, ["withdraw", "arbitrary_call"]],
  [/owner|admin|control|renounc|who can|role|permission/i, ["ownership_transfer", "renounce", "role_management", "other_admin"]],
  [/safe|risk|vulnerab|exploit|secur|investigat|audit|danger/i, ["__findings__"]],
];

export const CONTEXT_CHAR_BUDGET = 28_000;
const SOURCE_BUDGET = 12_000;

function words(q: string): string[] {
  return q.toLowerCase().match(/[a-z_][a-z0-9_]{2,}/g) ?? [];
}

function sanitise(s: string): string {
  // Neutralise our own delimiters if they appear inside contract-derived text.
  return s.replace(/<\/?\s*contract_data[^>]*>/gi, "[tag removed]");
}

export interface BuiltContext {
  text: string;
  refs: Set<string>;
}

export function buildContext(report: Report, question: string): BuiltContext {
  const refs = new Set<string>();
  const qWords = new Set(words(question));
  const caps = new Set<string>();
  for (const [re, tags] of SYNONYMS) if (re.test(question)) tags.forEach((t) => caps.add(t));

  const lines: string[] = [];
  const push = (s: string) => lines.push(sanitise(s));

  push(`CONTRACT ${report.address} on ${report.network.name} (chain ${report.network.chainId}).`);
  push(`Name: ${report.contractName ?? "unknown"}. Classification: ${report.classification.label}. Analysis depth: ${report.depth}.`);
  push(`Verification: ${report.verification.note}`);
  push(`Standards: ${report.classification.standards.map((s) => `${s.name} (${s.confidence})`).join(", ") || "none identified"}. Patterns: ${report.classification.patterns.map((p) => p.name).join(", ") || "none"}.`);

  refs.add("ONCHAIN:account");
  push(`[ONCHAIN:account] block ${report.onchain.blockNumber}; native balance ${report.onchain.balanceFormatted ?? "unknown"} (contract's own balance, not TVL); bytecode ${report.onchain.bytecodeSize} bytes.`);
  refs.add("ONCHAIN:proxy");
  push(
    `[ONCHAIN:proxy] ${report.proxy.isProxy ? `Proxy pattern ${report.proxy.pattern}; implementation ${report.proxy.implementation ?? "unresolved"}; admin ${report.proxy.admin ?? "n/a"}; beacon ${report.proxy.beacon ?? "n/a"}; upgradeable: ${report.proxy.upgradeable}. ${report.proxy.notes.join(" ")}` : `Not a recognised proxy. ${report.proxy.notes.join(" ")}`}`,
  );
  if (report.token) {
    refs.add("ONCHAIN:token");
    const t = report.token;
    push(`[ONCHAIN:token] ${t.standard} name=${JSON.stringify(t.name ?? null)} symbol=${JSON.stringify(t.symbol ?? null)} decimals=${t.decimals ?? "?"} totalSupply=${t.totalSupplyFormatted ?? t.totalSupply ?? "?"} maxSupply=${t.maxSupplyFormatted ?? t.maxSupply ?? "not established"}.`);
  }
  if (report.ownership) {
    refs.add("ONCHAIN:ownership");
    push(`[ONCHAIN:ownership] owner=${report.ownership.owner ?? "n/a"}. ${report.ownership.assessment} Other authorities: ${report.ownership.otherAuthorities.join("; ") || "none detected"}.`);
  }

  push("\nPERMISSIONS (all):");
  if (!report.permissions.length) push("(none identified)");
  for (const p of report.permissions) {
    refs.add(p.id);
    push(`[${p.id}] ${p.title}. Authority: ${p.authority}. Functions: ${p.functions.join(", ")}. Confidence ${p.confidence}. Limits: ${p.limitations}`);
  }

  const wantFindings = caps.has("__findings__");
  const scoredFindings = report.findings
    .map((f) => {
      let s = wantFindings ? 2 : 0;
      for (const w of words(`${f.title} ${f.category} ${f.ruleId}`)) if (qWords.has(w)) s += 2;
      for (const c of caps) if (f.ruleId.includes(c.replace("_change", "")) || f.category.toLowerCase().includes(c.split("_")[0]!)) s += 1;
      return { f, s };
    })
    .sort((a, b) => b.s - a.s)
    .slice(0, 25);
  push("\nSECURITY FINDINGS (most relevant first):");
  if (!report.findings.length) push("(none detected — this does not mean the contract is safe)");
  for (const { f } of scoredFindings) {
    refs.add(f.id);
    const loc = f.evidence.find((e) => e.location)?.location;
    push(`[${f.id}] ${f.severity}/${f.confidence} ${f.kind}: ${f.title}. ${f.explanation.slice(0, 400)}${loc ? ` (${loc.file}:${loc.line})` : ""}`);
  }

  const scoredFns = report.functions
    .map((fn) => {
      let s = 0;
      if (qWords.has(fn.name.toLowerCase())) s += 5;
      for (const w of words(fn.name.replace(/([a-z])([A-Z])/g, "$1 $2"))) if (qWords.has(w)) s += 1;
      for (const t of fn.tags) if (caps.has(t)) s += 3;
      if (fn.accessControl.restricted) s += 0.5;
      return { fn, s };
    })
    .sort((a, b) => b.s - a.s);
  push("\nFUNCTIONS (most relevant with detail; others listed by signature):");
  for (const { fn } of scoredFns.slice(0, 14)) {
    const id = `FN:${fn.signature}`;
    refs.add(id);
    push(
      `[${id}] ${fn.mutability}; ${fn.accessControl.restricted ? `restricted by ${fn.accessControl.mechanism}` : "no restriction detected"}; ${fn.explanation}${fn.location ? ` (${fn.location.file}:${fn.location.line})` : ""}${fn.natspec ? ` NatSpec (author's claim): ${JSON.stringify(fn.natspec.slice(0, 200))}` : ""}`,
    );
  }
  const rest = scoredFns.slice(14).map(({ fn }) => {
    refs.add(`FN:${fn.signature}`);
    return `[FN:${fn.signature}]`;
  });
  if (rest.length) push(`Other functions: ${rest.join(" ")}`);

  // Source excerpts for the top functions.
  let budget = SOURCE_BUDGET;
  const excerpts: string[] = [];
  if (report.sources.length) {
    for (const { fn, s } of scoredFns.slice(0, 8)) {
      if (!fn.location || (s <= 0 && excerpts.length >= 2)) continue;
      const file = report.sources.find((f) => f.path === fn.location!.file);
      if (!file) continue;
      const all = file.content.split("\n");
      const end = Math.min(fn.location.endLine ?? fn.location.line + 20, fn.location.line + 50);
      const body = all.slice(fn.location.line - 1, end).join("\n");
      const id = `SRC:${fn.location.file}#L${fn.location.line}-${end}`;
      if (body.length > budget) break;
      budget -= body.length;
      refs.add(id);
      excerpts.push(`[${id}]\n${body}`);
    }
  }
  if (excerpts.length) {
    push("\nVERIFIED SOURCE EXCERPTS:");
    for (const e of excerpts) push(e);
  } else push(report.depth === "bytecode" ? "\nNo verified source is available." : "");

  push("\nANALYSIS LIMITATIONS:");
  for (const l of report.limitations) push(`- ${l}`);

  let text = lines.join("\n");
  if (text.length > CONTEXT_CHAR_BUDGET) text = text.slice(0, CONTEXT_CHAR_BUDGET) + "\n[context truncated]";
  return { text, refs };
}

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { AnalyzeForm } from "@/components/analyze-form";
import { CodeLines } from "@/components/solidity";
import { KindBadge, SeverityBadge } from "@/components/ui";
import { publicNetworks } from "@/lib/networks/registry";
import type { Report } from "@/lib/analysis/types";
import sampleJson from "@/data/sample-report.json";

export const dynamic = "force-dynamic"; // network list reflects server env (disabled networks, configured RPCs)

const sample = sampleJson as unknown as Report;

function sourceSlice(file: string, from: number, to: number): string[] {
  const f = sample.sources.find((s) => s.path === file);
  return f ? f.content.split("\n").slice(from - 1, to) : [];
}

function demo() {
  const fn = sample.functions.find((f) => f.name === "setBlacklist");
  const gate = sample.findings.find((f) => f.ruleId === "admin-controlled-transfer-conditions");
  const perm = sample.permissions.find((p) => p.capability === "blacklist");
  const transferEv = gate?.evidence[0]?.location;
  return { fn, gate, perm, transferEv };
}

const STEPS = [
  { t: "Choose the network and paste an address", d: "UNWRAP checks the chain ID of the RPC it talks to and confirms there is contract code at that address." },
  { t: "On-chain facts are read directly", d: "Bytecode, balance, proxy storage slots, token metadata and the current owner come from the chain, not from a third party." },
  { t: "Verified source is fetched and parsed", d: "From the network's own explorer, with Sourcify as a fallback. Proxies are followed to their implementation." },
  { t: "Every claim comes with evidence", d: "Functions, permissions and findings link to source lines or on-chain reads. Ask follow-up questions; answers cite the same evidence." },
];

const FEATURES = [
  { t: "Permission inspector", d: "Who can mint, pause, block addresses, change fees or upgrade the code, and the exact function and line that grants it." },
  { t: "Security analysis", d: "Syntax-tree rules for reentrancy, unchecked calls, tx.origin auth, unsafe delegatecall and missing access control, plus Slither when the worker is deployed." },
  { t: "Proxy awareness", d: "EIP-1967 transparent, UUPS, beacon and EIP-1167 minimal proxies. UNWRAP separates today's logic from what an upgrade could change." },
  { t: "Token facts", d: "Name, symbol, decimals and total supply read on-chain. Max supply is shown only when the contract states one." },
  { t: "Plain-English functions", d: "Every callable function with its selector, mutability, access rule and a short explanation. Searchable." },
  { t: "Evidence-bound AI", d: "Ask questions about one contract. Answers must cite report evidence; references the model invents are removed and flagged." },
];

const FAQ = [
  {
    q: "Does UNWRAP tell me whether a contract is safe?",
    a: "No. It shows what the code allows and which known risk patterns appear. Absence of findings is not proof of safety, and UNWRAP is not a substitute for a professional audit.",
  },
  {
    q: "Why do I have to choose a network?",
    a: "The same address can be empty on one chain and a completely different contract on another. Guessing would risk analysing the wrong code.",
  },
  {
    q: "What if the contract's source is not verified?",
    a: "UNWRAP still reads the bytecode: function selectors, proxy patterns and risky opcodes. The report is marked as bytecode-only, and findings carry low confidence.",
  },
  {
    q: "Do I need to connect a wallet?",
    a: "No. Analysis is read-only. UNWRAP never asks for a wallet connection, a signature, a seed phrase or a private key.",
  },
  {
    q: "Does it test whether a token can be sold?",
    a: "Not yet. No transaction simulation is run, so UNWRAP never claims a token is or is not a honeypot. It shows the transfer conditions an administrator controls.",
  },
  {
    q: "Who can see my report?",
    a: "Public reports are reachable by anyone with the link, which contains an unguessable identifier. Private reports are visible only to the browser that created them.",
  },
];

export default function Home() {
  const networks = publicNetworks();
  const { fn, gate, perm, transferEv } = demo();
  const exampleFindings = ["reentrancy-state-after-call", "admin-fee-unbounded", "missing-access-control"]
    .map((r) => sample.findings.find((f) => f.ruleId === r))
    .filter((f): f is NonNullable<typeof f> => Boolean(f));

  return (
    <>
      {/* 1. Hero */}
      <section id="analyse" className="relative overflow-hidden border-b border-line">
        <div className="hero-grid pointer-events-none absolute inset-0" aria-hidden />
        <div className="relative mx-auto max-w-6xl px-5 pb-16 pt-16 sm:pb-24 sm:pt-24">
          <h1 className="font-display max-w-4xl text-[clamp(2.6rem,7.2vw,5.6rem)] font-bold leading-[0.95] tracking-[-0.035em]">
            <span className="unwrap-reveal block">Every contract has a story.</span>
            <span className="unwrap-reveal-2 block text-accent">Unwrap it.</span>
          </h1>
          <p className="mt-6 max-w-2xl text-lg text-fg-2">
            Understand smart contracts in plain English. Inspect permissions, investigate potential risks, and explore on-chain functionality with AI-powered analysis.
          </p>
          <div className="mt-9 max-w-3xl">
            <AnalyzeForm networks={networks} />
          </div>
          <div className="mt-5 flex max-w-3xl flex-wrap items-center gap-x-4 gap-y-2 text-sm text-fg-2">
            <span>
              Works on <span className="text-fg">Robinhood Chain</span>
              {networks.filter((n) => !n.primary).length > 0 && ` and ${networks.filter((n) => !n.primary).map((n) => n.shortName).join(", ")}`}.
            </span>
            <Link href="/sample" className="inline-flex items-center gap-1 text-accent hover:underline">
              Explore a sample report <ArrowUpRight size={14} aria-hidden />
            </Link>
          </div>
        </div>
      </section>

      {/* 2. Demonstration */}
      {fn?.location && gate && perm && (
        <section className="mx-auto max-w-6xl px-5 py-20" aria-labelledby="demo-h">
          <h2 id="demo-h" className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">
            From Solidity to a sentence you can act on
          </h2>
          <p className="mt-3 max-w-2xl text-fg-2">
            Taken from the sample report: UNWRAP run against a deliberately unsafe test token deployed on a local development chain. It is not a live contract.
          </p>
          <div className="mt-10 grid overflow-hidden rounded-lg border border-line lg:grid-cols-[1.15fr_1fr]">
            <div className="border-b border-line bg-bg-2 lg:border-b-0 lg:border-r">
              <p className="border-b border-line px-4 py-2 font-mono text-xs text-fg-3">{fn.location.file}</p>
              <CodeLines lines={sourceSlice(fn.location.file, fn.location.line, fn.location.endLine ?? fn.location.line)} startLine={fn.location.line} />
              {transferEv && (
                <>
                  <p className="border-y border-line px-4 py-2 font-mono text-xs text-fg-3">{transferEv.file}</p>
                  <CodeLines lines={sourceSlice(transferEv.file, transferEv.line, transferEv.line + 4)} startLine={transferEv.line} highlightLines={new Set([transferEv.line + 2])} />
                </>
              )}
            </div>
            <div className="space-y-6 bg-card p-6">
              <div>
                <p className="text-sm text-fg-3">Permission</p>
                <p className="mt-1 font-display text-xl font-semibold">{perm.title}</p>
                <p className="mt-2 text-fg-2">{perm.explanation}</p>
                <p className="mt-2 text-sm text-fg-2">
                  Held by: <span className="text-fg">{perm.authority}</span>, via <span className="font-mono text-[13px] text-fg">{fn.accessControl.mechanism}</span>
                </p>
              </div>
              <div className="border-t border-line pt-6">
                <div className="flex flex-wrap items-center gap-2">
                  <SeverityBadge severity={gate.severity} />
                  <KindBadge kind={gate.kind} />
                </div>
                <p className="mt-2 font-medium">{gate.title}</p>
                <p className="mt-1 text-sm text-fg-2">{gate.explanation}</p>
                <p className="mt-2 text-sm text-fg-3">{gate.limitations}</p>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* 3. How it works */}
      <section id="how-it-works" className="border-y border-line bg-bg-2" aria-labelledby="how-h">
        <div className="mx-auto max-w-6xl px-5 py-20">
          <h2 id="how-h" className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">
            How UNWRAP works
          </h2>
          <ol className="mt-10 grid gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((s, i) => (
              <li key={s.t}>
                <span className="font-display text-4xl font-bold text-accent">{i + 1}</span>
                <p className="mt-2 font-medium">{s.t}</p>
                <p className="mt-1 text-sm text-fg-2">{s.d}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* 4. Core features */}
      <section className="mx-auto max-w-6xl px-5 py-20" aria-labelledby="feat-h">
        <h2 id="feat-h" className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">
          What a report contains
        </h2>
        <dl className="mt-10 grid gap-x-12 gap-y-8 md:grid-cols-2">
          {FEATURES.map((f) => (
            <div key={f.t} className="border-l-2 border-line-2 pl-5">
              <dt className="font-medium">{f.t}</dt>
              <dd className="mt-1 text-fg-2">{f.d}</dd>
            </div>
          ))}
        </dl>
      </section>

      {/* 5. Example findings */}
      <section className="mx-auto max-w-6xl px-5 pb-20" aria-labelledby="ex-h">
        <h2 id="ex-h" className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">
          Example findings
        </h2>
        <p className="mt-3 max-w-2xl text-fg-2">Real output from the sample report. Each finding states how much weight it can bear and what it cannot tell you.</p>
        <ul className="mt-8 divide-y divide-line rounded-lg border border-line">
          {exampleFindings.map((f) => (
            <li key={f.id} className="grid gap-3 p-5 md:grid-cols-[220px_1fr]">
              <div className="flex flex-wrap content-start gap-2">
                <SeverityBadge severity={f.severity} />
                <KindBadge kind={f.kind} />
              </div>
              <div>
                <p className="font-medium">{f.title}</p>
                <p className="mt-1 text-sm text-fg-2">{f.explanation}</p>
                {f.evidence[0]?.location && (
                  <p className="mt-2 font-mono text-xs text-fg-3">
                    {f.evidence[0].location.file}:{f.evidence[0].location.line}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ul>
        <Link href="/sample" className="mt-5 inline-flex items-center gap-1 text-accent hover:underline">
          Open the full sample report <ArrowUpRight size={14} aria-hidden />
        </Link>
      </section>

      {/* 6. Supported networks */}
      <section className="border-y border-line bg-bg-2" aria-labelledby="net-h">
        <div className="mx-auto max-w-6xl px-5 py-20">
          <h2 id="net-h" className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">
            Supported networks
          </h2>
          <p className="mt-3 max-w-2xl text-fg-2">
            Robinhood Chain is the primary network. Every network runs the same analysis; what differs is where verified source comes from.
          </p>
          <div className="scrollbar-thin mt-8 overflow-x-auto rounded-lg border border-line">
            <table className="w-full min-w-[620px] text-left text-sm">
              <thead className="bg-card text-fg-2">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Network</th>
                  <th scope="col" className="px-4 py-3 font-medium">Chain ID</th>
                  <th scope="col" className="px-4 py-3 font-medium">Verified source from</th>
                  <th scope="col" className="px-4 py-3 font-medium">Explorer</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {networks.map((n) => (
                  <tr key={n.id} className={n.primary ? "bg-accent/[0.04]" : undefined}>
                    <td className="px-4 py-3">
                      {n.name}
                      {n.primary && !n.testnet && <span className="ml-2 text-xs text-accent">Primary</span>}
                    </td>
                    <td className="px-4 py-3 font-mono text-[13px] text-fg-2">{n.chainId}</td>
                    <td className="px-4 py-3 text-fg-2">{n.sourceVerification.join(", ")}</td>
                    <td className="px-4 py-3">
                      <a href={n.explorerUrl} target="_blank" rel="noopener noreferrer" className="text-fg-2 hover:text-fg">
                        {n.explorerName}
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* 7. Transparency and limitations */}
      <section id="limitations" className="mx-auto max-w-6xl px-5 py-20" aria-labelledby="lim-h">
        <h2 id="lim-h" className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">
          What UNWRAP cannot tell you
        </h2>
        <div className="mt-8 grid gap-10 md:grid-cols-2">
          <ul className="space-y-4 text-fg-2">
            <li><span className="text-fg">It does not prove safety.</span> Static analysis finds known patterns. New or subtle bugs can pass unnoticed.</li>
            <li><span className="text-fg">It does not simulate trades.</span> It will not tell you a token is or is not a honeypot.</li>
            <li><span className="text-fg">Unverified contracts get a shallow look.</span> Without source, function names are guesses from selectors.</li>
          </ul>
          <ul className="space-y-4 text-fg-2">
            <li><span className="text-fg">Upgradeable contracts can change.</span> The report describes the current implementation only.</li>
            <li><span className="text-fg">Holder data is not shown.</span> It needs an indexer, and UNWRAP will not estimate it.</li>
            <li><span className="text-fg">AI answers can be wrong.</span> Check the evidence each answer cites. Contract comments are the author&apos;s claims, not facts.</li>
          </ul>
        </div>
      </section>

      {/* 8. FAQ */}
      <section id="faq" className="mx-auto max-w-3xl px-5" aria-labelledby="faq-h">
        <h2 id="faq-h" className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">
          Questions
        </h2>
        <div className="mt-8 divide-y divide-line border-y border-line">
          {FAQ.map((f) => (
            <details key={f.q} className="group py-4">
              <summary className="flex cursor-pointer items-center justify-between gap-4 font-medium">
                {f.q}
                <span className="text-xl leading-none text-fg-3 transition-transform group-open:rotate-45" aria-hidden>
                  +
                </span>
              </summary>
              <p className="mt-2 text-fg-2">{f.a}</p>
            </details>
          ))}
        </div>
      </section>
    </>
  );
}

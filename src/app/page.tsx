import type { ReactNode } from "react";
import Link from "next/link";
import { AnalyzeForm } from "@/components/analyze-form";
import { CodeLines } from "@/components/solidity";
import { KindBadge, SeverityBadge } from "@/components/ui";
import { publicNetworks } from "@/lib/networks/registry";
import type { Report } from "@/lib/analysis/types";
import sampleJson from "@/data/sample-report.json";
import exhibit from "@/data/sample-exhibit.json";

export const dynamic = "force-dynamic"; // network list reflects server env

const sample = sampleJson as unknown as Report;

function sourceSlice(file: string, from: number, to: number): string[] {
  const f = sample.sources.find((s) => s.path === file);
  return f ? f.content.split("\n").slice(from - 1, to) : [];
}

const STEPS = [
  { t: "Pick the network, paste the address", d: "UNWRAP confirms it is talking to the right chain and that the address holds contract code." },
  { t: "Read the chain directly", d: "Bytecode, balance, proxy storage slots, token details and the current owner, straight from the network." },
  { t: "Fetch and parse the verified source", d: "From the network's own explorer, with Sourcify as a fallback. Proxies are followed to the code they run." },
  { t: "Report with evidence", d: "Every function, permission and finding points to a source line or an on-chain read. Ask follow-up questions; answers cite the same evidence." },
];

const FEATURES = [
  { t: "Who can do what", d: "Mint, pause, block addresses, change fees, upgrade the code: who holds each power, and the line that grants it." },
  { t: "Security findings, graded honestly", d: "Each finding says whether it is confirmed behaviour, a potential vulnerability or a heuristic warning, with its confidence. No single score hides the detail." },
  { t: "Proxies unwrapped", d: "EIP-1967, UUPS, beacon and minimal proxies are followed to their implementation, and upgrade risk is reported separately from today's code." },
  { t: "Every function in plain English", d: "Selector, access rule, what it changes, and a one-line explanation. Searchable." },
  { t: "Questions answered from evidence", d: "Ask about the contract. Answers must cite the report; anything the AI cannot back up is flagged." },
];

const FAQ = [
  { q: "Does UNWRAP tell me whether a contract is safe?", a: "No. It shows what the code allows and which known risk patterns appear. No findings is not proof of safety, and UNWRAP is not a substitute for a professional audit." },
  { q: "Why do I have to choose a network?", a: "The same address can be empty on one chain and a different contract on another. Guessing would risk analysing the wrong code." },
  { q: "What if the source isn't verified?", a: "UNWRAP still reads the bytecode: function selectors, proxy patterns and risky opcodes. The report says it is bytecode-only, and findings carry low confidence." },
  { q: "Do I need to connect a wallet?", a: "No. Analysis is read-only. UNWRAP never asks for a wallet connection, a signature, a seed phrase or a private key." },
  { q: "Does it test whether a token can be sold?", a: "Not yet. No trades are simulated, so UNWRAP never says a token is or isn't a honeypot. It shows which transfer conditions an administrator controls." },
  { q: "Who can see my report?", a: "Public reports open for anyone with the link, which contains an unguessable ID. Private reports open only in the browser that created them." },
];

function Section({ id, title, children }: { id?: string; title: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-20 border-t border-line">
      <div className="mx-auto grid max-w-[1180px] gap-6 px-5 py-16 md:grid-cols-[260px_1fr] md:gap-12 md:py-20">
        <h2 className="font-display text-[1.65rem] font-bold leading-[1.1] md:sticky md:top-20 md:self-start">{title}</h2>
        <div className="min-w-0">{children}</div>
      </div>
    </section>
  );
}

function Exhibit() {
  const fn = sample.functions.find((f) => f.signature === exhibit.signature);
  const perm = sample.permissions.find((p) => p.capability === "mint" && p.authority === "owner");
  if (!fn?.location || !perm) return null;
  const hex = exhibit.hex;
  const s = exhibit.selectorOffset;
  return (
    <figure className="relative mx-auto w-full min-w-0 max-w-[520px] lg:mx-0" aria-label="Example: one function unwrapped from bytecode to plain English">
      {/* Layer 1: bytecode */}
      <div className="peel-1 relative z-0 rounded-md border border-line-2 bg-card-2 px-5 pb-10 pt-4 shadow-[0_1px_0_rgba(17,20,18,0.06)]">
        <p className="text-[13px] text-fg-3">What the chain stores</p>
        <p className="mt-1.5 break-all font-mono text-[13px] leading-relaxed tracking-wide text-fg-2">
          {hex.slice(0, s)}
          <span className="rounded-sm bg-fg px-0.5 text-card">{hex.slice(s, s + 10)}</span>
          {hex.slice(s + 10)}
        </p>
        <p className="mt-2 text-[13px] text-fg-2">
          <span className="font-mono text-[12px] text-fg">{exhibit.selector}</span> is the ID of the mint function.
        </p>
      </div>
      {/* Layer 2: Solidity */}
      <div className="peel-2 relative z-10 -mt-6 ml-3 overflow-hidden rounded-md shadow-[0_12px_30px_-12px_rgba(17,20,18,0.45)] sm:ml-6">
        <p className="bg-code px-4 pt-3 text-[13px] text-code-muted">What the developer wrote</p>
        <CodeLines wrap lines={sourceSlice(fn.location.file, fn.location.line, fn.location.endLine ?? fn.location.line)} startLine={fn.location.line} highlightLines={new Set([fn.location.line])} />
      </div>
      {/* Layer 3: plain English */}
      <div className="relative z-20 -mt-5 ml-6 rounded-md border border-line-2 bg-card px-5 py-4 shadow-[0_14px_34px_-14px_rgba(17,20,18,0.35)] sm:ml-12">
        <p className="text-[13px] text-fg-3">What it means</p>
        <p className="mt-1.5 text-[1.12rem] font-medium leading-snug">
          <span className="mark mark-in">The owner can create new tokens</span> at any time. No cap was found, so new supply can dilute holders.
        </p>
        <p className="mt-2 text-[13px] text-fg-2">
          Evidence: <span className="font-mono text-[12px]">{fn.location.file}:{fn.location.line}</span>, guarded by <span className="font-mono text-[12px]">onlyOwner</span>
        </p>
      </div>
      <figcaption className="mt-3 pl-6 text-[13px] text-fg-3 sm:pl-12">
        From the{" "}
        <Link href="/sample" className="underline decoration-line-2 underline-offset-2 hover:text-fg">
          sample report
        </Link>
        : a deliberately unsafe test token on a local chain.
      </figcaption>
    </figure>
  );
}

export default function Home() {
  const networks = publicNetworks();
  const mainnets = networks.filter((n) => !n.primary);
  const exampleFindings = ["reentrancy-state-after-call", "admin-controlled-transfer-conditions", "missing-access-control"]
    .map((r) => sample.findings.find((f) => f.ruleId === r))
    .filter((f): f is NonNullable<typeof f> => Boolean(f));

  return (
    <>
      <section id="analyse" className="scroll-mt-20">
        <div className="mx-auto grid max-w-[1180px] items-center gap-14 px-5 pb-20 pt-12 md:pt-16 lg:grid-cols-[minmax(0,1.08fr)_minmax(0,1fr)] lg:gap-16 lg:pb-24">
          <div className="min-w-0">
            <h1 className="font-display text-[clamp(2.5rem,6.4vw,4.9rem)] font-extrabold leading-[0.98] tracking-[-0.035em]">
              Every contract has a story. Unwrap it.
            </h1>
            <p className="mt-6 max-w-[34rem] text-[1.12rem] leading-relaxed text-fg-2">
              Understand smart contracts in plain English. Inspect permissions, investigate potential risks, and explore on-chain functionality with AI-powered analysis.
            </p>
            <div className="mt-9">
              <AnalyzeForm networks={networks} />
            </div>
            <p className="mt-5 max-w-[36rem] text-[15px] text-fg-2">
              Built for <span className="font-medium text-fg">Robinhood Chain</span>, and works on {mainnets.map((n) => n.shortName).join(", ")}.{" "}
              <Link href="/sample" className="font-medium text-accent underline decoration-accent/40 underline-offset-[3px] hover:decoration-accent">
                See a sample report
              </Link>
            </p>
          </div>
          <Exhibit />
        </div>
      </section>

      <Section id="how-it-works" title="How it works">
        <ol className="grid gap-x-10 gap-y-9 sm:grid-cols-2">
          {STEPS.map((s, i) => (
            <li key={s.t} className="grid grid-cols-[2.2rem_1fr] gap-x-3">
              <span className="font-display text-[1.65rem] font-bold leading-none text-fg-3">{i + 1}</span>
              <div>
                <p className="font-semibold">{s.t}</p>
                <p className="mt-1 text-fg-2">{s.d}</p>
              </div>
            </li>
          ))}
        </ol>
      </Section>

      <Section title="In every report">
        <dl className="divide-y divide-line">
          {FEATURES.map((f) => (
            <div key={f.t} className="grid gap-1 py-5 first:pt-0 sm:grid-cols-[220px_1fr] sm:gap-8">
              <dt className="font-semibold">{f.t}</dt>
              <dd className="max-w-[38rem] text-fg-2">{f.d}</dd>
            </div>
          ))}
        </dl>
      </Section>

      <Section title="What findings look like">
        <p className="max-w-[38rem] text-fg-2">Real output from the sample report. Each finding says how much weight it can bear, and what it cannot tell you.</p>
        <ul className="mt-8 space-y-4">
          {exampleFindings.map((f) => (
            <li key={f.id} className="rounded-md border border-line bg-card p-5">
              <div className="flex flex-wrap items-center gap-2">
                <SeverityBadge severity={f.severity} />
                <KindBadge kind={f.kind} />
                {f.evidence[0]?.location && (
                  <span className="ml-auto font-mono text-[12px] text-fg-3">
                    {f.evidence[0].location.file}:{f.evidence[0].location.line}
                  </span>
                )}
              </div>
              <p className="mt-3 font-semibold">{f.title}</p>
              <p className="mt-1 max-w-[42rem] text-[15px] text-fg-2">{f.explanation}</p>
            </li>
          ))}
        </ul>
        <Link href="/sample" className="mt-6 inline-block font-medium text-accent underline decoration-accent/40 underline-offset-[3px] hover:decoration-accent">
          Open the full sample report
        </Link>
      </Section>

      <Section title="Networks">
        <p className="max-w-[38rem] text-fg-2">Robinhood Chain comes first. Every network gets the same analysis; what differs is where the verified source comes from.</p>
        <div className="scrollbar-thin mt-8 overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-[15px]">
            <thead className="text-[13px] text-fg-3">
              <tr className="border-b border-line-2">
                <th scope="col" className="pb-2 pr-4 font-medium">Network</th>
                <th scope="col" className="pb-2 pr-4 font-medium">Chain ID</th>
                <th scope="col" className="pb-2 pr-4 font-medium">Verified source</th>
                <th scope="col" className="pb-2 font-medium">Explorer</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {networks.map((n) => (
                <tr key={n.id}>
                  <td className="py-3 pr-4 font-medium">
                    {n.primary ? <span className="mark">{n.name}</span> : n.name}
                  </td>
                  <td className="py-3 pr-4 font-mono text-[13px] text-fg-2">{n.chainId}</td>
                  <td className="py-3 pr-4 text-fg-2">{n.sourceVerification.join(", ")}</td>
                  <td className="py-3">
                    {n.explorerUrl ? (
                      <a href={n.explorerUrl} target="_blank" rel="noopener noreferrer" className="text-fg-2 underline decoration-line-2 underline-offset-2 hover:text-fg">
                        {n.explorerName}
                      </a>
                    ) : (
                      <span className="text-fg-3">None</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section id="limitations" title="What UNWRAP can't tell you">
        <ul className="grid max-w-[46rem] gap-x-10 gap-y-5 sm:grid-cols-2">
          {[
            ["Whether it's safe.", "Static analysis finds known patterns. New or subtle bugs can slip through."],
            ["Whether you can sell.", "No trades are simulated, so there is no honeypot verdict."],
            ["Much, if the source is hidden.", "Without verified source, function names are guesses from selectors."],
            ["What an upgrade will do.", "Upgradeable contracts are reported as they are today."],
            ["Who holds the token.", "Holder data needs an indexer; UNWRAP won't estimate it."],
            ["That the AI is right.", "Check the evidence each answer cites. Code comments are the author's claims."],
          ].map(([a, b]) => (
            <li key={a}>
              <p className="font-semibold">{a}</p>
              <p className="mt-0.5 text-fg-2">{b}</p>
            </li>
          ))}
        </ul>
      </Section>

      <Section id="faq" title="Questions">
        <div className="max-w-[44rem] divide-y divide-line border-y border-line">
          {FAQ.map((f) => (
            <details key={f.q} className="group py-4">
              <summary className="flex cursor-pointer items-center justify-between gap-4 font-semibold">
                {f.q}
                <span className="text-xl font-normal leading-none text-fg-3 transition-transform group-open:rotate-45" aria-hidden>
                  +
                </span>
              </summary>
              <p className="mt-2 text-fg-2">{f.a}</p>
            </details>
          ))}
        </div>
      </Section>
    </>
  );
}

"use client";

import type { ReactNode } from "react";
import type { Report } from "@/lib/analysis/types";
import { explorerAddress, groupDigits } from "@/lib/format";
import { CopyButton, InfoHint, Notice, Tag } from "@/components/ui";
import { EvidenceList } from "./evidence";
import type { Nav } from "./report-view";

function Row({ k, children }: { k: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-1 border-b border-line py-3 sm:grid-cols-[200px_1fr]">
      <dt className="text-sm text-fg-3">{k}</dt>
      <dd className="min-w-0 break-words text-sm">{children}</dd>
    </div>
  );
}

function Addr({ a, explorerUrl }: { a: string; explorerUrl: string }) {
  const link = explorerAddress(explorerUrl, a);
  return (
    <span className="inline-flex max-w-full items-center gap-1">
      {link ? (
        <a href={link} target="_blank" rel="noopener noreferrer" className="truncate font-mono text-[13px] hover:text-accent">
          {a}
        </a>
      ) : (
        <span className="truncate font-mono text-[13px]">{a}</span>
      )}
      <CopyButton value={a} label="Copy address" />
    </span>
  );
}

export function OverviewTab({ r, nav }: { r: Report; nav: Nav }) {
  const hasSource = r.sources.length > 0;
  return (
    <div className="grid gap-12 [overflow-wrap:anywhere] lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="min-w-0 space-y-10">
        <section aria-labelledby="ov-contract">
          <h3 id="ov-contract" className="font-display text-xl font-semibold">Contract</h3>
          <dl className="mt-3">
            <Row k="Classification">{r.classification.label}</Row>
            <Row k="Standards">
              {r.classification.standards.length ? (
                <ul className="space-y-1">
                  {r.classification.standards.map((s) => (
                    <li key={s.name}>
                      {s.name} <span className="text-xs text-fg-3">({s.confidence} confidence: {s.evidence})</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="text-fg-2">No token standard identified.</span>
              )}
            </Row>
            <Row k="Patterns">{r.classification.patterns.length ? <div className="flex flex-wrap gap-1.5">{r.classification.patterns.map((p) => <Tag key={p.name}>{p.name}</Tag>)}</div> : <span className="text-fg-2">None recognised</span>}</Row>
            {r.inheritance.length > 0 && <Row k="Inheritance">{r.inheritance.join(" → ")}</Row>}
            <Row k="Network">
              {r.network.name} <span className="font-mono text-xs text-fg-3">chain {r.network.chainId}</span>
            </Row>
            <Row k="Verification">
              {r.verification.note}
              {r.verification.compilerVersion && <span className="block font-mono text-xs text-fg-3">{r.verification.compilerVersion}</span>}
            </Row>
          </dl>
        </section>

        <section aria-labelledby="ov-chain">
          <h3 id="ov-chain" className="font-display text-xl font-semibold">On-chain data</h3>
          <dl className="mt-3">
            <Row k="Block">{r.onchain.blockNumber ?? "unknown"}</Row>
            <Row
              k={
                <span className="inline-flex items-center gap-1">
                  Native balance <InfoHint label={r.onchain.note} />
                </span>
              }
            >
              {r.onchain.balanceFormatted ?? "Not available"}
            </Row>
            <Row k="Transaction count">{r.onchain.nonce ?? "unknown"}</Row>
            <Row k="Bytecode">
              {r.onchain.bytecodeSize.toLocaleString()} bytes
              {r.onchain.bytecodeHash && <span className="block truncate font-mono text-xs text-fg-3">{r.onchain.bytecodeHash}</span>}
            </Row>
          </dl>
        </section>

        {r.token && (
          <section aria-labelledby="ov-token">
            <h3 id="ov-token" className="font-display text-xl font-semibold">Token</h3>
            <dl className="mt-3">
              <Row k="Standard">{r.token.standard}</Row>
              <Row k="Name and symbol">
                {r.token.name ?? <span className="text-fg-3">not returned</span>} {r.token.symbol && <span className="text-fg-2">({r.token.symbol})</span>}
              </Row>
              {r.token.decimals !== undefined && <Row k="Decimals">{r.token.decimals}</Row>}
              <Row k="Total supply (current)">{r.token.totalSupplyFormatted ? groupDigits(r.token.totalSupplyFormatted) : (r.token.totalSupply ?? "unknown")}</Row>
              <Row k="Maximum supply">
                {r.token.maxSupply ? (
                  <>
                    {r.token.maxSupplyFormatted ? groupDigits(r.token.maxSupplyFormatted) : r.token.maxSupply}
                    <span className="block text-xs text-fg-3">{r.token.maxSupplySource}</span>
                  </>
                ) : (
                  <span className="text-fg-2">Not established. The contract exposes no cap; current supply is not a maximum.</span>
                )}
              </Row>
              <Row k="Holders">
                <span className="text-fg-2">{r.token.holdersNote}</span>
              </Row>
            </dl>
          </section>
        )}
      </div>

      <div className="min-w-0 space-y-10">
        <section aria-labelledby="ov-proxy">
          <h3 id="ov-proxy" className="font-display text-xl font-semibold">Proxy and upgradeability</h3>
          {r.proxy.isProxy ? (
            <dl className="mt-3">
              <Row k="Pattern">{r.proxy.pattern}</Row>
              {r.proxy.implementation && <Row k="Implementation"><Addr a={r.proxy.implementation} explorerUrl={r.network.explorerUrl} /></Row>}
              {r.implementation && <Row k="Implementation source">{r.implementation.verified ? `Verified (${r.implementation.contractName ?? "unnamed"})` : "Not verified: analysed from bytecode"}</Row>}
              {r.proxy.admin && <Row k="Proxy admin"><Addr a={r.proxy.admin} explorerUrl={r.network.explorerUrl} /></Row>}
              {r.proxy.beacon && <Row k="Beacon"><Addr a={r.proxy.beacon} explorerUrl={r.network.explorerUrl} /></Row>}
              <Row k="Can the logic change?">{r.proxy.upgradeable === "yes" ? "Yes" : r.proxy.upgradeable === "no" ? "No" : "Not determined"}</Row>
            </dl>
          ) : (
            <p className="mt-3 text-sm text-fg-2">No recognised proxy pattern. UNWRAP checks EIP-1967 (transparent, UUPS, beacon), EIP-1167 and legacy ZeppelinOS slots.</p>
          )}
          {r.proxy.notes.length > 0 && (
            <ul className="mt-3 space-y-1.5 text-sm text-fg-2">
              {r.proxy.notes.map((n) => <li key={n}>{n}</li>)}
            </ul>
          )}
          {r.proxy.evidence.length > 0 && (
            <div className="mt-3">
              <EvidenceList items={r.proxy.evidence} nav={nav} hasSource={hasSource} />
            </div>
          )}
        </section>

        <section aria-labelledby="ov-owner">
          <h3 id="ov-owner" className="font-display text-xl font-semibold">Who is in control</h3>
          {r.ownership ? (
            <div className="mt-3 space-y-3 text-sm">
              {r.ownership.owner && (
                <p>
                  Owner: <Addr a={r.ownership.owner} explorerUrl={r.network.explorerUrl} />
                  {r.ownership.ownerIsContract !== undefined && <span className="ml-1 text-fg-3">({r.ownership.ownerIsContract ? "contract" : r.ownership.ownerIsZero ? "zero address" : "wallet"})</span>}
                </p>
              )}
              <p className="leading-relaxed text-fg-2">{r.ownership.assessment}</p>
              {r.ownership.otherAuthorities.length > 0 && (
                <div>
                  <p className="text-fg-3">Other authorities</p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5 text-fg-2">
                    {r.ownership.otherAuthorities.map((a) => <li key={a}>{a}</li>)}
                  </ul>
                </div>
              )}
            </div>
          ) : (
            <p className="mt-3 text-sm text-fg-2">No owner getter and no other administrative authority was detected{r.depth === "bytecode" ? " (bytecode-only analysis, so this is weak evidence)" : ""}.</p>
          )}
        </section>

        <section aria-labelledby="ov-lim">
          <h3 id="ov-lim" className="font-display text-xl font-semibold">Limitations of this report</h3>
          <ul className="mt-3 space-y-2 text-sm text-fg-2">
            {r.limitations.map((l) => (
              <li key={l} className="border-l-2 border-line-2 pl-3">{l}</li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="ov-tools">
          <h3 id="ov-tools" className="font-display text-xl font-semibold">Analysers and data sources</h3>
          <ul className="mt-3 space-y-2 text-sm">
            {r.analysers.map((a) => (
              <li key={a.name}>
                <span className="text-fg">{a.name}</span> <Tag tone={a.status === "ran" ? "accent" : a.status === "failed" ? "warn" : "plain"}>{a.status.replace("_", " ")}</Tag>
                <span className="block text-fg-2">{a.detail}</span>
              </li>
            ))}
            {r.steps.map((s) => (
              <li key={s.step}>
                <span className="text-fg">{s.step}</span> <Tag tone={s.status === "ok" ? "accent" : s.status === "failed" ? "warn" : "plain"}>{s.status}</Tag>
                <span className="block break-words text-fg-2">{s.detail}</span>
              </li>
            ))}
          </ul>
        </section>
        {r.depth === "bytecode" && <Notice tone="warn">This contract&apos;s source is not verified. Function names are inferred from selectors and may be wrong.</Notice>}
      </div>
    </div>
  );
}

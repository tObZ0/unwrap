"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { LoaderCircle, Search } from "lucide-react";
import type { ReportListItem } from "@/lib/server/store";
import { DEPTH_LABEL, formatDate, shortAddress } from "@/lib/format";
import { EmptyState, Notice, SeverityBadge, Tag, cx } from "./ui";

const TYPES = ["ERC-20 token", "NFT collection (ERC-721)", "Multi-token (ERC-1155)", "Multisig wallet", "AMM liquidity pair", "DEX router", "Timelock controller", "Tokenised vault (ERC-4626)", "Smart contract"];
const PAGE = 20;

export function ReportsBrowser({ networks, persistent }: { networks: { id: string; name: string }[]; persistent: boolean }) {
  const [q, setQ] = useState("");
  const [network, setNetwork] = useState("");
  const [type, setType] = useState("");
  const [severity, setSeverity] = useState("");
  const [mine, setMine] = useState(false);
  const [items, setItems] = useState<ReportListItem[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function load(offset: number, append: boolean) {
    setLoading(true);
    setError(null);
    const p = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
    if (q.trim()) p.set("q", q.trim());
    if (network) p.set("network", network);
    if (type) p.set("type", type);
    if (severity) p.set("severity", severity);
    if (mine) p.set("mine", "1");
    try {
      const res = await fetch(`/api/reports?${p}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      setItems((prev) => (append && prev ? [...prev, ...body.items] : body.items));
      setMore(body.items.length === PAGE);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const t = setTimeout(() => load(0, false), q ? 300 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, network, type, severity, mine]);

  const sel = "h-10 rounded-md border border-line bg-bg-2 px-2 text-sm text-fg";
  return (
    <div className="mt-8">
      {!persistent && (
        <div className="mb-6">
          <Notice tone="info" title="Development storage">No database is configured, so this list only holds reports created since the server last started.</Notice>
        </div>
      )}
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-[1fr_auto_auto_auto_auto]">
        <label className="relative sm:col-span-2 lg:col-span-1">
          <span className="sr-only">Search by address or contract name</span>
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-3" aria-hidden />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by address or contract name" className="h-10 w-full rounded-md border border-line bg-bg-2 pl-9 pr-3 text-sm placeholder:text-fg-3" />
        </label>
        <select aria-label="Network" value={network} onChange={(e) => setNetwork(e.target.value)} className={sel}>
          <option value="">All networks</option>
          {networks.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
        </select>
        <select aria-label="Contract type" value={type} onChange={(e) => setType(e.target.value)} className={sel}>
          <option value="">All types</option>
          {TYPES.map((t) => <option key={t}>{t}</option>)}
        </select>
        <select aria-label="Findings" value={severity} onChange={(e) => setSeverity(e.target.value)} className={sel}>
          <option value="">Any findings</option>
          <option value="critical">Critical findings</option>
          <option value="high">High or worse</option>
          <option value="medium">Medium or worse</option>
          <option value="low">Low or worse</option>
        </select>
        <label className="flex h-10 items-center gap-2 rounded-md border border-line px-3 text-sm text-fg-2">
          <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} className="size-4 accent-[var(--color-accent)]" />
          Created in this browser
        </label>
      </div>

      {error && <div className="mt-6"><Notice tone="error">{error}</Notice></div>}
      {items === null && !error && (
        <div className="mt-6 space-y-2" aria-busy="true">
          {Array.from({ length: 4 }, (_, i) => <div key={i} className="skeleton h-16" />)}
        </div>
      )}
      {items && items.length === 0 && (
        <div className="mt-6">
          <EmptyState title={q || network || type || severity || mine ? "No reports match these filters" : "No reports yet"}>
            {q || network || type || severity || mine ? "Try removing a filter." : <Link className="text-accent hover:underline" href="/#analyse">Analyse the first contract</Link>}
          </EmptyState>
        </div>
      )}
      {items && items.length > 0 && (
        <ul className="mt-6 divide-y divide-line rounded-lg border border-line">
          {items.map((it) => {
            const worst = (["critical", "high", "medium", "low"] as const).find((s) => it.counts[s] > 0);
            return (
              <li key={it.id}>
                <Link href={`/report/${it.id}`} className="grid gap-2 px-4 py-3 hover:bg-card sm:grid-cols-[1fr_auto] sm:items-center">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{it.contractName ?? "Unnamed contract"} <span className="font-mono text-sm font-normal text-fg-2">{shortAddress(it.address)}</span></p>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                      <Tag tone={it.networkId.startsWith("robinhood") ? "accent" : "plain"}>{it.networkName}</Tag>
                      <Tag>{it.label}</Tag>
                      <Tag tone={it.depth === "source" ? "plain" : "warn"}>{DEPTH_LABEL[it.depth]}</Tag>
                      {it.visibility === "private" && <Tag>Private</Tag>}
                    </div>
                  </div>
                  <div className="flex items-center gap-3 sm:justify-end">
                    {worst ? <span className="flex items-center gap-1.5 text-sm"><SeverityBadge severity={worst} /> <span className="text-fg-2">{it.counts[worst]}</span></span> : <span className="text-sm text-fg-3">No findings above info</span>}
                    <span className="text-xs text-fg-3">{formatDate(it.createdAt)}</span>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {more && items && (
        <button type="button" onClick={() => load(items.length, true)} disabled={loading} className={cx("mt-4 inline-flex h-10 items-center gap-2 rounded-md border border-line px-4 text-sm hover:bg-card", loading && "opacity-60")}>
          {loading && <LoaderCircle size={15} className="animate-spin" aria-hidden />} Load more
        </button>
      )}
    </div>
  );
}

"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, LoaderCircle, Lock, ScanSearch } from "lucide-react";
import type { PublicNetwork } from "@/lib/networks/registry";
import { cx, Notice } from "./ui";

interface ApiError {
  code: string;
  message: string;
}

const ERROR_HELP: Record<string, string> = {
  NO_CONTRACT_CODE: "Check that you picked the network the contract lives on. The same address can be empty on one chain and a contract on another.",
  NETWORK_UNAVAILABLE: "The network's RPC endpoint did not respond. Public endpoints are rate-limited; try again shortly.",
  CHAIN_ID_MISMATCH: "The configured RPC endpoint is serving a different chain. The operator needs to fix the RPC configuration.",
  RATE_LIMITED: "You have run several analyses in a short time.",
  UPSTREAM_ERROR: "A service UNWRAP depends on was slow or unavailable.",
};

const WORK = [
  "Confirming the network and that the address holds contract code",
  "Reading bytecode, balance and proxy storage slots",
  "Looking up verified source on the network's explorer and Sourcify",
  "Parsing the source and mapping functions, permissions and risks",
  "Running static analysis rules (and Slither, when configured)",
];

export function AnalyzeForm({ networks, compact = false }: { networks: PublicNetwork[]; compact?: boolean }) {
  const router = useRouter();
  const ids = { net: useId(), addr: useId(), err: useId() };
  const [network, setNetwork] = useState("");
  const [address, setAddress] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<ApiError | null>(null);
  const [fieldError, setFieldError] = useState<{ network?: string; address?: string }>({});
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearInterval(timer.current);
  }, []);

  const primary = networks.filter((n) => n.primary);
  const others = networks.filter((n) => !n.primary);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const fe: typeof fieldError = {};
    if (!network) fe.network = "Choose the network this contract is deployed on. UNWRAP does not guess, because the same address can hold different contracts on different chains.";
    if (!/^0x[0-9a-fA-F]{40}$/.test(address.trim())) fe.address = "Enter a contract address: 0x followed by 40 hexadecimal characters.";
    setFieldError(fe);
    if (fe.network || fe.address) return;

    setBusy(true);
    setElapsed(0);
    const started = Date.now();
    timer.current = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ network, address: address.trim(), visibility: isPrivate ? "private" : "public" }),
      });
      const body = (await res.json().catch(() => null)) as { id?: string; error?: ApiError } | null;
      if (!res.ok || !body?.id) {
        setError(body?.error ?? { code: "INTERNAL", message: `The server returned HTTP ${res.status}.` });
        return;
      }
      router.push(`/report/${body.id}`);
    } catch {
      setError({ code: "OFFLINE", message: "Could not reach the UNWRAP server. Check your connection and try again." });
    } finally {
      if (timer.current) clearInterval(timer.current);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate aria-describedby={error ? ids.err : undefined} className="w-full">
      <div className={cx("rounded-lg border border-line-2 bg-card p-2 sm:p-2.5", busy && "opacity-70")}>
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="relative sm:w-56">
            <label htmlFor={ids.net} className="sr-only">
              Network
            </label>
            <select
              id={ids.net}
              value={network}
              onChange={(e) => {
                setNetwork(e.target.value);
                setFieldError((f) => ({ ...f, network: undefined }));
              }}
              disabled={busy}
              aria-invalid={Boolean(fieldError.network)}
              className={cx(
                "h-12 w-full appearance-none rounded-md border bg-bg-2 pl-3 pr-9 text-[15px] text-fg",
                fieldError.network ? "border-sev-critical/60" : "border-line",
                !network && "text-fg-2",
              )}
            >
              <option value="">Choose network</option>
              <optgroup label="Robinhood Chain">
                {primary.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.name}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Other EVM networks">
                {others.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.name}
                  </option>
                ))}
              </optgroup>
            </select>
            <ChevronDown size={16} aria-hidden className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-fg-3" />
          </div>
          <label htmlFor={ids.addr} className="sr-only">
            Contract address
          </label>
          <input
            id={ids.addr}
            value={address}
            onChange={(e) => {
              setAddress(e.target.value);
              setFieldError((f) => ({ ...f, address: undefined }));
            }}
            disabled={busy}
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="0x… contract address"
            aria-invalid={Boolean(fieldError.address)}
            className={cx(
              "h-12 min-w-0 flex-1 rounded-md border bg-bg-2 px-3 font-mono text-[14px] text-fg placeholder:font-sans placeholder:text-fg-3",
              fieldError.address ? "border-sev-critical/60" : "border-line",
            )}
          />
          <button
            type="submit"
            disabled={busy}
            className="inline-flex h-12 items-center justify-center gap-2 rounded-md bg-accent px-5 font-medium text-accent-ink hover:brightness-110 disabled:cursor-wait"
          >
            {busy ? <LoaderCircle size={18} className="animate-spin" aria-hidden /> : <ScanSearch size={18} aria-hidden />}
            {busy ? "Analysing" : "Analyse contract"}
          </button>
        </div>
        {!compact && (
          <label className="mt-2 flex w-fit cursor-pointer items-center gap-2 px-1 text-sm text-fg-2">
            <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} disabled={busy} className="size-4 accent-[var(--color-accent)]" />
            <Lock size={14} aria-hidden />
            Private report: only this browser can open it
          </label>
        )}
      </div>

      {(fieldError.network || fieldError.address) && (
        <ul className="mt-2 space-y-1 text-sm text-sev-critical" role="alert">
          {fieldError.network && <li>{fieldError.network}</li>}
          {fieldError.address && <li>{fieldError.address}</li>}
        </ul>
      )}

      {busy && (
        <div className="mt-4 rounded-lg border border-line bg-bg-2 p-4" role="status" aria-live="polite">
          <p className="text-sm text-fg">
            Analysing on {networks.find((n) => n.id === network)?.name}: {elapsed}s elapsed. Most contracts take 5 to 40 seconds.
          </p>
          <ul className="mt-3 space-y-1.5 text-sm text-fg-2">
            {WORK.map((w) => (
              <li key={w} className="flex gap-2">
                <span className="mt-2 size-1.5 shrink-0 rounded-full bg-fg-3" aria-hidden />
                {w}
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && (
        <div id={ids.err} className="mt-4">
          <Notice tone="error" title={error.message}>
            {ERROR_HELP[error.code] ?? null}
          </Notice>
        </div>
      )}
    </form>
  );
}

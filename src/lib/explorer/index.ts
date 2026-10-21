import { getAddress } from "viem";
import type { NetworkConfig } from "@/lib/networks/registry";
import type { SourceFile, VerifiedSource } from "@/lib/analysis/types";
import { AppError } from "@/lib/errors";

/** Minimal fetch contract so the explorer layer can be tested without network. */
export type Fetcher = (url: string, init?: { timeoutMs?: number }) => Promise<{ ok: boolean; status: number; text: string }>;

export interface SourceLookupAttempt {
  provider: VerifiedSource["provider"];
  outcome: "verified" | "not_verified" | "unavailable" | "not_configured";
  detail: string;
}

export interface SourceLookupResult {
  source: VerifiedSource | null;
  attempts: SourceLookupAttempt[];
}

const MAX_FILES = 400;
const MAX_TOTAL_SOURCE_BYTES = 6 * 1024 * 1024;

/** Strip anything that is not plain text and bound length for upstream messages we echo. */
function cleanUpstreamMessage(s: unknown): string {
  return String(s ?? "")
    .replace(/[^\x20-\x7E]/g, " ")
    .slice(0, 200);
}

/**
 * Explorer `SourceCode` comes in three shapes:
 *  1. Plain Solidity text (single file).
 *  2. `{{ ...standard-json-input... }}` (Etherscan wraps standard JSON in double braces).
 *  3. `{ "path.sol": { "content": "..." } }` (older multi-file format).
 */
export function parseExplorerSourceCode(raw: string, contractName: string): SourceFile[] {
  const s = raw.trim();
  if (!s) return [];
  if (s.startsWith("{")) {
    const candidates = s.startsWith("{{") ? [s.slice(1, -1), s] : [s];
    for (const c of candidates) {
      try {
        const parsed = JSON.parse(c) as Record<string, unknown>;
        const sources = (parsed.sources ?? parsed) as Record<string, { content?: unknown }>;
        const files: SourceFile[] = [];
        for (const [path, v] of Object.entries(sources)) {
          if (v && typeof v === "object" && typeof v.content === "string") files.push({ path, content: v.content });
        }
        if (files.length) return files;
      } catch {
        /* try next shape */
      }
    }
  }
  return [{ path: `${contractName || "Contract"}.sol`, content: raw }];
}

function boundFiles(files: SourceFile[]): SourceFile[] {
  let total = 0;
  const out: SourceFile[] = [];
  for (const f of files.slice(0, MAX_FILES)) {
    total += f.content.length;
    if (total > MAX_TOTAL_SOURCE_BYTES) break;
    out.push({ path: f.path.slice(0, 300), content: f.content });
  }
  return out;
}

function parseAbi(raw: unknown): unknown[] | null {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function maybeAddress(v: unknown): string | undefined {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(v)) return undefined;
  if (/^0x0{40}$/i.test(v)) return undefined;
  return getAddress(v);
}

interface EtherscanSourceRow {
  SourceCode?: string;
  ABI?: string;
  ContractName?: string;
  CompilerVersion?: string;
  OptimizationUsed?: string;
  Runs?: string;
  EVMVersion?: string;
  LicenseType?: string;
  Proxy?: string;
  Implementation?: string;
  // Blockscout extensions
  AdditionalSources?: { Filename?: string; SourceCode?: string }[];
  FileName?: string;
  ImplementationAddress?: string;
  IsProxy?: string;
}

function rowToSource(row: EtherscanSourceRow, provider: "etherscan-v2" | "blockscout"): VerifiedSource | null {
  if (!row.SourceCode || !row.SourceCode.trim()) return null;
  const name = (row.ContractName ?? "Contract").slice(0, 120);
  let files = parseExplorerSourceCode(row.SourceCode, name);
  if (provider === "blockscout") {
    if (files.length === 1 && row.FileName) files[0] = { path: row.FileName, content: files[0]!.content };
    for (const extra of row.AdditionalSources ?? []) {
      if (extra.Filename && typeof extra.SourceCode === "string") files.push({ path: extra.Filename, content: extra.SourceCode });
    }
  }
  files = boundFiles(files);
  return {
    provider,
    contractName: name,
    compilerVersion: row.CompilerVersion || undefined,
    optimization: row.OptimizationUsed ? `${row.OptimizationUsed === "1" ? "enabled" : "disabled"}${row.Runs ? `, ${row.Runs} runs` : ""}` : undefined,
    evmVersion: row.EVMVersion || undefined,
    license: row.LicenseType || undefined,
    files,
    abi: parseAbi(row.ABI),
    explorerImplementation: maybeAddress(row.Implementation) ?? maybeAddress(row.ImplementationAddress),
  };
}

export async function lookupEtherscan(n: NetworkConfig, address: string, f: Fetcher): Promise<{ source: VerifiedSource | null; attempt: SourceLookupAttempt }> {
  const key = n.explorer.api.apiKeyEnvVar ? process.env[n.explorer.api.apiKeyEnvVar] : undefined;
  if (!key) {
    return {
      source: null,
      attempt: { provider: "etherscan-v2", outcome: "not_configured", detail: "ETHERSCAN_API_KEY is not set, so Etherscan V2 was skipped." },
    };
  }
  const url = `${n.explorer.api.baseUrl}?chainid=${n.chainId}&module=contract&action=getsourcecode&address=${address}&apikey=${encodeURIComponent(key)}`;
  const res = await f(url);
  if (!res.ok) return { source: null, attempt: { provider: "etherscan-v2", outcome: "unavailable", detail: `Etherscan V2 returned HTTP ${res.status}.` } };
  let body: { status?: string; message?: string; result?: unknown };
  try {
    body = JSON.parse(res.text);
  } catch {
    return { source: null, attempt: { provider: "etherscan-v2", outcome: "unavailable", detail: "Etherscan V2 returned a non-JSON response." } };
  }
  if (body.status !== "1" || !Array.isArray(body.result)) {
    return {
      source: null,
      attempt: { provider: "etherscan-v2", outcome: "unavailable", detail: `Etherscan V2: ${cleanUpstreamMessage(body.result ?? body.message)}` },
    };
  }
  const source = rowToSource(body.result[0] as EtherscanSourceRow, "etherscan-v2");
  return {
    source,
    attempt: { provider: "etherscan-v2", outcome: source ? "verified" : "not_verified", detail: source ? "Verified source found." : "No verified source on Etherscan." },
  };
}

export async function lookupBlockscout(n: NetworkConfig, address: string, f: Fetcher): Promise<{ source: VerifiedSource | null; attempt: SourceLookupAttempt }> {
  const base = n.explorer.api.baseUrl!.replace(/\/$/, "");
  const res = await f(`${base}/api?module=contract&action=getsourcecode&address=${address}`);
  if (!res.ok) return { source: null, attempt: { provider: "blockscout", outcome: "unavailable", detail: `Blockscout returned HTTP ${res.status}.` } };
  let body: { status?: string; message?: string; result?: unknown };
  try {
    body = JSON.parse(res.text);
  } catch {
    return { source: null, attempt: { provider: "blockscout", outcome: "unavailable", detail: "Blockscout returned a non-JSON response." } };
  }
  if (!Array.isArray(body.result) || body.result.length === 0) {
    return { source: null, attempt: { provider: "blockscout", outcome: "not_verified", detail: `Blockscout: ${cleanUpstreamMessage(body.message || "no result")}` } };
  }
  const source = rowToSource(body.result[0] as EtherscanSourceRow, "blockscout");
  return {
    source,
    attempt: { provider: "blockscout", outcome: source ? "verified" : "not_verified", detail: source ? "Verified source found." : "No verified source on Blockscout." },
  };
}

interface SourcifyContract {
  match?: string | null;
  abi?: unknown[];
  sources?: Record<string, { content?: string }>;
  compilation?: { name?: string; fullyQualifiedName?: string; compilerVersion?: string; compilerSettings?: { optimizer?: { enabled?: boolean; runs?: number }; evmVersion?: string } };
  proxyResolution?: { isProxy?: boolean; implementations?: { address?: string }[] };
}

export async function lookupSourcify(n: NetworkConfig, address: string, f: Fetcher): Promise<{ source: VerifiedSource | null; attempt: SourceLookupAttempt }> {
  const res = await f(`https://sourcify.dev/server/v2/contract/${n.chainId}/${address}?fields=abi,sources,compilation,proxyResolution`);
  if (res.status === 404) return { source: null, attempt: { provider: "sourcify", outcome: "not_verified", detail: "Not verified on Sourcify." } };
  if (!res.ok) return { source: null, attempt: { provider: "sourcify", outcome: "unavailable", detail: `Sourcify returned HTTP ${res.status}.` } };
  let body: SourcifyContract;
  try {
    body = JSON.parse(res.text);
  } catch {
    return { source: null, attempt: { provider: "sourcify", outcome: "unavailable", detail: "Sourcify returned a non-JSON response." } };
  }
  if (!body.match || !body.sources) return { source: null, attempt: { provider: "sourcify", outcome: "not_verified", detail: "Not verified on Sourcify." } };
  const files = boundFiles(
    Object.entries(body.sources)
      .filter(([, v]) => typeof v?.content === "string")
      .map(([path, v]) => ({ path, content: v.content! })),
  );
  const opt = body.compilation?.compilerSettings?.optimizer;
  return {
    source: {
      provider: "sourcify",
      contractName: (body.compilation?.name ?? "Contract").slice(0, 120),
      compilerVersion: body.compilation?.compilerVersion,
      optimization: opt ? `${opt.enabled ? "enabled" : "disabled"}${opt.runs ? `, ${opt.runs} runs` : ""}` : undefined,
      evmVersion: body.compilation?.compilerSettings?.evmVersion,
      files,
      abi: Array.isArray(body.abi) ? body.abi : null,
      explorerImplementation: maybeAddress(body.proxyResolution?.implementations?.[0]?.address),
    },
    attempt: { provider: "sourcify", outcome: "verified", detail: `Sourcify ${body.match} match.` },
  };
}

/** Tries the chain's own explorer first, then Sourcify. Never throws for upstream failures. */
export async function lookupVerifiedSource(n: NetworkConfig, address: string, f: Fetcher): Promise<SourceLookupResult> {
  const attempts: SourceLookupAttempt[] = [];
  type Lookup = typeof lookupSourcify;
  const tries: [VerifiedSource["provider"], Lookup][] = [];
  if (n.explorer.api.kind === "blockscout") tries.push(["blockscout", lookupBlockscout]);
  if (n.explorer.api.kind === "etherscan-v2") tries.push(["etherscan-v2", lookupEtherscan]);
  if (n.sourcify) tries.push(["sourcify", lookupSourcify]);

  for (const [provider, lookup] of tries) {
    try {
      const { source, attempt } = await lookup(n, address, f);
      attempts.push(attempt);
      if (source && source.files.length > 0) return { source, attempts };
    } catch (e) {
      attempts.push({ provider, outcome: "unavailable", detail: e instanceof AppError ? e.message : "Lookup failed." });
    }
  }
  return { source: null, attempts };
}

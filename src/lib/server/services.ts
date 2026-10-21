import "server-only";
import { AppError } from "@/lib/errors";
import { getNetwork } from "@/lib/networks/registry";
import { createChainReader } from "@/lib/networks/chain-reader";
import { analyseContract, validateAddress } from "@/lib/analysis/pipeline";
import type { Fetcher } from "@/lib/explorer";
import type { WorkerPost } from "@/lib/analysis/slither";
import type { Report } from "@/lib/analysis/types";
import { safeFetch, withRetry } from "./safe-fetch";
import { getStore, type Visibility } from "./store";
import { newReportId, withTimeout } from "./http";

export const fetchText: Fetcher = (url, init) =>
  withRetry(async () => {
    const r = await safeFetch(url, { timeoutMs: init?.timeoutMs ?? 15_000, headers: { Accept: "application/json" } });
    if (r.status === 429 || r.status >= 500) {
      // Surface as retryable, then as a normal non-ok response if retries are exhausted.
      throw Object.assign(new AppError("UPSTREAM_ERROR", `HTTP ${r.status}`), { response: r });
    }
    return r;
  }).catch((e: unknown) => {
    const resp = (e as { response?: { ok: boolean; status: number; text: string } }).response;
    if (resp) return resp;
    throw e;
  });

export const postJson: WorkerPost = async (url, body, headers, timeoutMs) => {
  const r = await safeFetch(url, { method: "POST", body, headers, timeoutMs, maxBytes: 4 * 1024 * 1024 });
  return { ok: r.ok, status: r.status, text: r.text };
};

export function resolveNetwork(id: string) {
  const n = getNetwork(id);
  if (!n) throw new AppError("UNKNOWN_NETWORK", `Unknown network "${id.slice(0, 40)}". Choose one of the supported networks.`);
  if (!n.enabled) throw new AppError("NETWORK_DISABLED", `${n.name} is disabled on this deployment.`);
  return n;
}

export async function runAnalysis(input: { network: string; address: string; visibility: Visibility; refresh: boolean; ownerHash: string }): Promise<{ id: string; cached: boolean; report: Report }> {
  const network = resolveNetwork(input.network);
  const address = validateAddress(input.address);
  const store = await getStore();
  const cacheSeconds = Number(process.env.ANALYSIS_CACHE_SECONDS ?? 600);
  if (!input.refresh && input.visibility === "public" && cacheSeconds > 0) {
    const cached = await store.findRecentPublic(network.id, address, cacheSeconds);
    if (cached) return { id: cached.id, cached: true, report: cached };
  }
  try {
    const report = await withTimeout(
      analyseContract(network, address, { reader: createChainReader(network), fetchText, workerPost: postJson, newId: newReportId }),
      Number(process.env.ANALYSIS_TIMEOUT_MS ?? 170_000),
      "The analysis took too long and was stopped. The network or a verification service may be slow; try again.",
    );
    await store.saveReport(report, { visibility: input.visibility, ownerHash: input.ownerHash });
    await store.recordUsage("analyze", network.id, "ok");
    return { id: report.id, cached: false, report };
  } catch (e) {
    await store.recordUsage("analyze", network.id, e instanceof AppError ? e.code : "INTERNAL").catch(() => undefined);
    throw e;
  }
}

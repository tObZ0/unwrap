import type { Finding, Severity, Confidence, FindingKind, VerifiedSource } from "./types";

/** HTTP client for the isolated Slither worker (worker/slither_worker.py). */
export type WorkerPost = (url: string, body: string, headers: Record<string, string>, timeoutMs: number) => Promise<{ ok: boolean; status: number; text: string }>;

export interface SlitherResult {
  status: "ran" | "not_configured" | "failed" | "not_applicable";
  detail: string;
  findings: Finding[];
}

interface WorkerDetector {
  check: string;
  impact: string;
  confidence: string;
  description: string;
  location: { file: string; line: number; endLine?: number } | null;
}

const IMPACT: Record<string, Severity> = { High: "high", Medium: "medium", Low: "low", Informational: "info" };
const CONF: Record<string, Confidence> = { High: "high", Medium: "medium", Low: "low" };

export function slitherConfigured(): boolean {
  return Boolean(process.env.SLITHER_WORKER_URL && process.env.SLITHER_WORKER_TOKEN);
}

export function normaliseSlither(detectors: WorkerDetector[]): Finding[] {
  return detectors.slice(0, 80).map((d, i) => {
    const severity = IMPACT[d.impact] ?? "info";
    const kind: FindingKind = severity === "high" || severity === "medium" ? "potential_vulnerability" : severity === "low" ? "heuristic_warning" : "informational";
    const firstLine = d.description.split("\n")[0]!.trim();
    return {
      id: `SLITHER-${d.check.toUpperCase()}-${i + 1}`,
      ruleId: d.check,
      title: `Slither: ${d.check.replace(/-/g, " ")}`,
      severity,
      confidence: CONF[d.confidence] ?? "low",
      kind,
      category: "Slither detector",
      explanation: d.description.slice(0, 1000),
      evidence: [{ basis: "slither", description: firstLine.slice(0, 300), location: d.location ?? undefined }],
      recommendation: `See https://github.com/crytic/slither/wiki/Detector-Documentation for the "${d.check}" detector.`,
      limitations: "Slither reports patterns; each result needs manual review in context. Slither's text is shown as produced by the tool.",
      detector: "slither",
    };
  });
}

export async function runSlither(source: VerifiedSource | null, post: WorkerPost): Promise<SlitherResult> {
  if (!source) return { status: "not_applicable", detail: "No verified Solidity source, so there was nothing to run Slither on.", findings: [] };
  if (!slitherConfigured()) {
    return { status: "not_configured", detail: "SLITHER_WORKER_URL / SLITHER_WORKER_TOKEN are not set. Deploy worker/ to enable Slither.", findings: [] };
  }
  if (source.compilerVersion && /vyper/i.test(source.compilerVersion)) {
    return { status: "not_applicable", detail: "Vyper source; Slither's Vyper support is not enabled in the worker.", findings: [] };
  }
  const url = `${process.env.SLITHER_WORKER_URL!.replace(/\/$/, "")}/analyze`;
  try {
    const res = await post(
      url,
      JSON.stringify({ contractName: source.contractName, compilerVersion: source.compilerVersion ?? "", files: source.files }),
      { Authorization: `Bearer ${process.env.SLITHER_WORKER_TOKEN}`, "Content-Type": "application/json" },
      150_000,
    );
    let body: { detectors?: WorkerDetector[]; error?: string; detail?: string } = {};
    try {
      body = JSON.parse(res.text);
    } catch {
      /* fallthrough */
    }
    if (!res.ok) return { status: "failed", detail: `Slither worker: ${String(body.detail ?? body.error ?? `HTTP ${res.status}`).slice(0, 200)}`, findings: [] };
    const findings = normaliseSlither(body.detectors ?? []);
    return { status: "ran", detail: `Slither ran ${findings.length ? `and reported ${findings.length} result(s)` : "and reported no results"}.`, findings };
  } catch (e) {
    return { status: "failed", detail: `Slither worker unreachable: ${(e as Error).message?.slice(0, 120) ?? "error"}`, findings: [] };
  }
}

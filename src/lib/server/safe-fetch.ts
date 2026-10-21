import "server-only";
import { getNetworks, rpcUrlsFor } from "@/lib/networks/registry";
import { AppError } from "@/lib/errors";

/**
 * All server-side HTTP goes through `safeFetch`. It only reaches hosts that are
 * derived from server configuration (network registry, operator env vars and a
 * fixed set of public services). User input can never introduce a new host,
 * which closes off SSRF even if a URL were accidentally built from input.
 */
const STATIC_HOSTS = ["sourcify.dev", "api.4byte.sourcify.dev", "api.etherscan.io"];

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

export function allowedHosts(): Set<string> {
  const hosts = new Set<string>(STATIC_HOSTS);
  for (const n of getNetworks()) {
    for (const u of rpcUrlsFor(n)) {
      const h = hostOf(u);
      if (h) hosts.add(h);
    }
    const eh = hostOf(n.explorer.api.baseUrl);
    if (eh) hosts.add(eh);
  }
  for (const v of [process.env.AI_BASE_URL, process.env.SLITHER_WORKER_URL]) {
    const h = hostOf(v);
    if (h) hosts.add(h);
  }
  hosts.add("api.anthropic.com");
  hosts.add("api.openai.com");
  return hosts;
}

export interface SafeFetchOptions extends Omit<RequestInit, "signal"> {
  timeoutMs?: number;
  maxBytes?: number;
}

export interface SafeResponse {
  status: number;
  ok: boolean;
  text: string;
  json<T = unknown>(): T;
}

export async function safeFetch(url: string, opts: SafeFetchOptions = {}): Promise<SafeResponse> {
  const { timeoutMs = 15_000, maxBytes = 8 * 1024 * 1024, ...init } = opts;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AppError("INTERNAL", "Refused to fetch an invalid URL.");
  }
  const isLocalWorker = hostOf(process.env.SLITHER_WORKER_URL) === parsed.host.toLowerCase();
  if (parsed.protocol !== "https:" && !(isLocalWorker && parsed.protocol === "http:")) {
    throw new AppError("INTERNAL", "Refused to fetch a non-HTTPS URL.");
  }
  if (!allowedHosts().has(parsed.host.toLowerCase())) {
    throw new AppError("INTERNAL", "Refused to fetch a host that is not in the server allowlist.");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(parsed, { ...init, signal: controller.signal, redirect: "error" });
    const reader = res.body?.getReader();
    let received = 0;
    const chunks: Uint8Array[] = [];
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > maxBytes) {
          controller.abort();
          throw new AppError("PAYLOAD_TOO_LARGE", "An upstream response exceeded the size limit.");
        }
        chunks.push(value);
      }
    }
    const text = new TextDecoder().decode(concat(chunks, received));
    return {
      status: res.status,
      ok: res.ok,
      text,
      json<T>() {
        return JSON.parse(text) as T;
      },
    };
  } catch (e) {
    if (e instanceof AppError) throw e;
    if ((e as Error)?.name === "AbortError") {
      throw new AppError("UPSTREAM_ERROR", `Request to ${parsed.host} timed out.`);
    }
    throw new AppError("UPSTREAM_ERROR", `Request to ${parsed.host} failed.`);
  } finally {
    clearTimeout(timer);
  }
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/** Retry wrapper for transient upstream failures (timeouts, 429, 5xx). */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 2, baseDelayMs = 400): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const retryable = e instanceof AppError && (e.code === "UPSTREAM_ERROR" || e.code === "RATE_LIMITED");
      if (!retryable || i === attempts) break;
      await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** i));
    }
  }
  throw lastErr;
}

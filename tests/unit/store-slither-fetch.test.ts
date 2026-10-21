import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryStore, PostgresStore } from "@/lib/server/store";
import { normaliseSlither, runSlither } from "@/lib/analysis/slither";
import { safeFetch } from "@/lib/server/safe-fetch";
import type { Report, VerifiedSource } from "@/lib/analysis/types";
import sample from "@/data/sample-report.json";

const rep = (id: string, extra: Partial<Report> = {}): Report => ({ ...(structuredClone(sample) as unknown as Report), id, createdAt: new Date().toISOString(), ...extra });

describe("report storage and access control", () => {
  it("hides private reports from everyone except the owner", async () => {
    const s = new MemoryStore();
    await s.saveReport(rep("priv"), { visibility: "private", ownerHash: "alice" });
    expect(await s.getReport("priv", "bob")).toBeNull();
    expect(await s.getReport("priv", null)).toBeNull();
    expect((await s.getReport("priv", "alice"))?.isOwner).toBe(true);
    expect(await s.listReports({ limit: 10, offset: 0 }, "bob")).toEqual([]);
    expect(await s.setVisibility("priv", "public", "bob")).toBe(false);
    expect(await s.setVisibility("priv", "public", "alice")).toBe(true);
    expect(await s.getReport("priv", "bob")).not.toBeNull();
  });
  it("filters by network, type, severity and search", async () => {
    const s = new MemoryStore();
    await s.saveReport(rep("a"), { visibility: "public", ownerHash: null });
    await s.saveReport(rep("b", { findings: [], contractName: "Quiet", network: { ...sample.network, id: "base" } as Report["network"] }), { visibility: "public", ownerHash: null });
    expect((await s.listReports({ networkId: "base", limit: 10, offset: 0 }, null)).map((x) => x.id)).toEqual(["b"]);
    expect((await s.listReports({ minSeverity: "high", limit: 10, offset: 0 }, null)).map((x) => x.id)).toEqual(["a"]);
    expect((await s.listReports({ search: "quiet", limit: 10, offset: 0 }, null)).map((x) => x.id)).toEqual(["b"]);
    expect((await s.listReports({ label: "ERC-20 token", limit: 10, offset: 0 }, null)).length).toBe(2);
  });
  it("serves cached public reports only within the age limit", async () => {
    const s = new MemoryStore();
    const r = rep("c");
    await s.saveReport(r, { visibility: "public", ownerHash: null });
    expect((await s.findRecentPublic(r.network.id, r.address, 60))?.id).toBe("c");
    expect(await s.findRecentPublic(r.network.id, "0x0000000000000000000000000000000000000001", 60)).toBeNull();
  });
  it("rate-limits per key within a window", async () => {
    const s = new MemoryStore();
    const results = [];
    for (let i = 0; i < 4; i++) results.push((await s.hit("k", 3, 60)).allowed);
    expect(results).toEqual([true, true, true, false]);
    expect((await s.hit("other", 3, 60)).allowed).toBe(true);
  });
  it("turns database failures into a STORAGE_ERROR without leaking details", async () => {
    const s = new PostgresStore({ query: async () => Promise.reject(new Error("password authentication failed for user admin")) });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(s.getReport("x", null)).rejects.toMatchObject({ code: "STORAGE_ERROR", message: expect.not.stringContaining("password") });
    expect(await s.ping()).toBe(false);
    spy.mockRestore();
  });
});

describe("Slither client", () => {
  afterEach(() => {
    delete process.env.SLITHER_WORKER_URL;
    delete process.env.SLITHER_WORKER_TOKEN;
  });
  const src: VerifiedSource = { provider: "blockscout", contractName: "A", compilerVersion: "v0.8.26", files: [{ path: "A.sol", content: "contract A {}" }], abi: [] };
  it("maps Slither impact and confidence to findings", () => {
    const [f] = normaliseSlither([{ check: "reentrancy-eth", impact: "High", confidence: "Medium", description: "Reentrancy in A.w()\nmore", location: { file: "A.sol", line: 3 } }]);
    expect(f).toMatchObject({ severity: "high", confidence: "medium", kind: "potential_vulnerability", detector: "slither", evidence: [{ location: { file: "A.sol", line: 3 } }] });
  });
  it("reports not_configured / not_applicable honestly", async () => {
    const post = vi.fn();
    expect((await runSlither(src, post)).status).toBe("not_configured");
    expect((await runSlither(null, post)).status).toBe("not_applicable");
    expect(post).not.toHaveBeenCalled();
  });
  it("reports worker failures without inventing results", async () => {
    process.env.SLITHER_WORKER_URL = "https://worker.example";
    process.env.SLITHER_WORKER_TOKEN = "t";
    const r = await runSlither(src, async () => ({ ok: false, status: 422, text: JSON.stringify({ error: "compiler_not_installed", detail: "solc 0.8.26 is not installed" }) }));
    expect(r).toMatchObject({ status: "failed", findings: [], detail: expect.stringContaining("not installed") });
  });
});

describe("SSRF protection", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("refuses hosts outside the configured allowlist and non-https URLs", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(safeFetch("https://169.254.169.254/latest/meta-data")).rejects.toThrow(/allowlist/);
    await expect(safeFetch("https://evil.example/")).rejects.toThrow(/allowlist/);
    await expect(safeFetch("http://robinhoodchain.blockscout.com/api")).rejects.toThrow(/non-HTTPS/);
    await expect(safeFetch("file:///etc/passwd")).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("allows registry hosts, disables redirects, and enforces a size limit", async () => {
    const fetchSpy = vi.fn(async (_u: URL, init: RequestInit) => {
      expect(init.redirect).toBe("error");
      return new Response("x".repeat(2048));
    });
    vi.stubGlobal("fetch", fetchSpy);
    expect((await safeFetch("https://robinhoodchain.blockscout.com/api?x=1")).text.length).toBe(2048);
    await expect(safeFetch("https://sourcify.dev/server/v2", { maxBytes: 100 })).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
  });
});

describe("embedded migrations", () => {
  it("match the SQL files used by npm run db:migrate", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const { MIGRATIONS } = await import("@/lib/server/migrations");
    const files = readdirSync("db/migrations").filter((f) => f.endsWith(".sql")).sort();
    expect(MIGRATIONS.map((m) => m.version)).toEqual(files);
    for (const m of MIGRATIONS) expect(m.sql).toBe(readFileSync(`db/migrations/${m.version}`, "utf8"));
  });
});

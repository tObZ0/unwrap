import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { MemoryStore, setStoreForTesting } from "@/lib/server/store";
import type { Report } from "@/lib/analysis/types";
import sample from "@/data/sample-report.json";

vi.mock("@/lib/server/services", async (orig) => {
  const actual = await orig<typeof import("@/lib/server/services")>();
  return { ...actual, runAnalysis: vi.fn(actual.runAnalysis) };
});
import * as services from "@/lib/server/services";
import { POST as analyze } from "@/app/api/analyze/route";
import { GET as getReport, PATCH as patchReport } from "@/app/api/reports/[id]/route";
import { GET as listReports } from "@/app/api/reports/route";
import { POST as ask } from "@/app/api/ask/route";
import { GET as health } from "@/app/api/health/route";
import { GET as networks } from "@/app/api/networks/route";

const OWNER = "a".repeat(43);
const OTHER = "b".repeat(43);
const req = (url: string, init: { method?: string; body?: string; cookie?: string; ip?: string } = {}) =>
  new NextRequest(`http://localhost${url}`, {
    method: init.method ?? "GET",
    body: init.body,
    headers: { "content-type": "application/json", ...(init.cookie ? { cookie: `unwrap_owner=${init.cookie}` } : {}), "x-forwarded-for": init.ip ?? "203.0.113.7" },
  });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const ID = "AAAAAAAAAAAAAAAAAAAAAA";

let store: MemoryStore;
beforeEach(() => {
  store = new MemoryStore();
  setStoreForTesting(store);
});
afterEach(() => {
  setStoreForTesting(undefined);
  delete process.env.AI_API_KEY;
});

describe("POST /api/analyze", () => {
  it("rejects malformed JSON, oversize bodies, invalid addresses and unknown networks", async () => {
    expect((await analyze(req("/api/analyze", { method: "POST", body: "{not json" }))).status).toBe(400);
    expect((await analyze(req("/api/analyze", { method: "POST", body: JSON.stringify({ network: "robinhood", address: "x".repeat(5000) }) }))).status).toBe(413);
    const bad = await analyze(req("/api/analyze", { method: "POST", body: JSON.stringify({ network: "robinhood", address: "0x123" }) }));
    expect(await bad.json()).toMatchObject({ error: { code: "INVALID_ADDRESS" } });
    const unk = await analyze(req("/api/analyze", { method: "POST", body: JSON.stringify({ network: "solana", address: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045" }) }));
    expect(unk.status).toBe(400);
    expect(await unk.json()).toMatchObject({ error: { code: "UNKNOWN_NETWORK" } });
    const missing = await analyze(req("/api/analyze", { method: "POST", body: JSON.stringify({ address: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045" }) }));
    expect(await missing.json()).toMatchObject({ error: { code: "INVALID_INPUT" } });
  });

  it("sets an httpOnly owner cookie and returns the report id", async () => {
    vi.mocked(services.runAnalysis).mockResolvedValueOnce({ id: ID, cached: false, report: sample as unknown as Report });
    const res = await analyze(req("/api/analyze", { method: "POST", body: JSON.stringify({ network: "robinhood", address: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045" }) }));
    expect(await res.json()).toEqual({ id: ID, cached: false });
    expect(res.headers.get("set-cookie")).toMatch(/unwrap_owner=.*HttpOnly/i);
  });

  it("rate-limits expensive analysis per client", async () => {
    vi.mocked(services.runAnalysis).mockResolvedValue({ id: ID, cached: true, report: sample as unknown as Report });
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) statuses.push((await analyze(req("/api/analyze", { method: "POST", ip: "198.51.100.9", body: JSON.stringify({ network: "robinhood", address: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045" }) }))).status);
    expect(statuses.filter((s) => s === 429).length).toBe(2);
    const limited = await analyze(req("/api/analyze", { method: "POST", ip: "198.51.100.9", body: "{}" }));
    expect(limited.headers.get("retry-after")).toBeTruthy();
    vi.mocked(services.runAnalysis).mockReset();
  });

  it("returns a generic message for unexpected errors", async () => {
    vi.mocked(services.runAnalysis).mockRejectedValueOnce(new Error("TypeError at /srv/secret/path.ts:42"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await analyze(req("/api/analyze", { method: "POST", ip: "192.0.2.1", body: JSON.stringify({ network: "robinhood", address: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045" }) }));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("/srv/secret");
    spy.mockRestore();
  });
});

describe("report endpoints", () => {
  beforeEach(async () => {
    const { createHash } = await import("node:crypto");
    const h = createHash("sha256").update(OWNER).digest("hex");
    await store.saveReport({ ...(sample as unknown as Report), id: ID }, { visibility: "private", ownerHash: h });
  });
  it("hides private reports from other browsers (404, no existence leak)", async () => {
    expect((await getReport(req(`/api/reports/${ID}`, { cookie: OTHER }), params(ID))).status).toBe(404);
    expect((await getReport(req(`/api/reports/${ID}`), params(ID))).status).toBe(404);
    const own = await getReport(req(`/api/reports/${ID}`, { cookie: OWNER }), params(ID));
    expect(await own.json()).toMatchObject({ isOwner: true, visibility: "private", persistent: false });
  });
  it("rejects malformed ids and lets only the owner change visibility", async () => {
    expect((await getReport(req("/api/reports/../../etc"), params("../../etc"))).status).toBe(404);
    expect((await patchReport(req(`/api/reports/${ID}`, { method: "PATCH", cookie: OTHER, body: '{"visibility":"public"}' }), params(ID))).status).toBe(403);
    expect((await patchReport(req(`/api/reports/${ID}`, { method: "PATCH", cookie: OWNER, body: '{"visibility":"public"}' }), params(ID))).status).toBe(200);
    expect((await getReport(req(`/api/reports/${ID}`, { cookie: OTHER }), params(ID))).status).toBe(200);
  });
  it("lists only what the viewer may see and validates filters", async () => {
    expect((await (await listReports(req("/api/reports", { cookie: OTHER }))).json()).items).toEqual([]);
    expect((await (await listReports(req("/api/reports?mine=1", { cookie: OWNER }))).json()).items).toHaveLength(1);
    expect((await listReports(req("/api/reports?severity=catastrophic"))).status).toBe(400);
  });
});

describe("POST /api/ask", () => {
  beforeEach(async () => {
    await store.saveReport({ ...(sample as unknown as Report), id: ID }, { visibility: "public", ownerHash: null });
  });
  it("explains clearly when AI is not configured", async () => {
    const res = await ask(req("/api/ask", { method: "POST", body: JSON.stringify({ reportId: ID, question: "Can the owner mint?" }) }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "AI_NOT_CONFIGURED", message: expect.stringContaining("AI_API_KEY") } });
  });
  it("validates input and report existence", async () => {
    expect((await ask(req("/api/ask", { method: "POST", body: JSON.stringify({ reportId: ID, question: "" }) }))).status).toBe(400);
    expect((await ask(req("/api/ask", { method: "POST", body: JSON.stringify({ reportId: "BBBBBBBBBBBBBBBBBBBBBB", question: "Can the owner mint?" }) }))).status).toBe(404);
  });
});

describe("public configuration endpoints", () => {
  it("health and networks never expose secrets", async () => {
    process.env.AI_API_KEY = "sk-super-secret";
    process.env.ROBINHOOD_RPC_URL = "https://robinhood-mainnet.g.alchemy.com/v2/KEY123";
    const h = JSON.stringify(await (await health()).json());
    const n = JSON.stringify(await (await networks()).json());
    for (const body of [h, n]) {
      expect(body).not.toContain("sk-super-secret");
      expect(body).not.toContain("KEY123");
    }
    expect(JSON.parse(h)).toMatchObject({ storage: { kind: "memory", persistent: false }, ai: { configured: true } });
    delete process.env.ROBINHOOD_RPC_URL;
  });
});

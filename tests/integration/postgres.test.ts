/**
 * Runs PostgresStore against a real database. Skipped unless TEST_DATABASE_URL is set
 * (apply migrations first: DATABASE_URL=$TEST_DATABASE_URL npm run db:migrate).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { PostgresStore } from "@/lib/server/store";
import type { Report } from "@/lib/analysis/types";
import sample from "@/data/sample-report.json";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("PostgresStore on a real database", () => {
  const pool = new pg.Pool({ connectionString: url });
  const store = new PostgresStore(pool);
  const rid = () => Math.random().toString(36).slice(2).padEnd(22, "x").slice(0, 22);
  const mk = (id: string, extra: Partial<Report> = {}): Report => ({ ...(structuredClone(sample) as unknown as Report), id, createdAt: new Date().toISOString(), ...extra });

  beforeAll(async () => {
    await pool.query("TRUNCATE reports, ai_messages, rate_limits, usage_events");
  });
  afterAll(async () => {
    await pool.end();
  });

  it("round-trips reports and enforces private access", async () => {
    const id = rid();
    await store.saveReport(mk(id), { visibility: "private", ownerHash: "owner-a" });
    expect((await store.getReport(id, "owner-a"))?.report.address).toBe(sample.address);
    expect(await store.getReport(id, "owner-b")).toBeNull();
    expect(await store.setVisibility(id, "public", "owner-b")).toBe(false);
    expect(await store.setVisibility(id, "public", "owner-a")).toBe(true);
    expect(await store.getReport(id, null)).not.toBeNull();
  });

  it("searches with filters, escaping LIKE wildcards", async () => {
    await store.saveReport(mk(rid(), { contractName: "Quiet_Token", findings: [] }), { visibility: "public", ownerHash: null });
    expect((await store.listReports({ search: "quiet_", limit: 10, offset: 0 }, null)).map((r) => r.contractName)).toEqual(["Quiet_Token"]);
    expect((await store.listReports({ search: "%", limit: 10, offset: 0 }, null))).toEqual([]);
    const high = await store.listReports({ minSeverity: "high", limit: 10, offset: 0 }, null);
    expect(high.every((r) => r.counts.high + r.counts.critical > 0)).toBe(true);
    expect(high.length).toBe(1);
  });

  it("finds a recent cached public report", async () => {
    const r = await store.findRecentPublic(sample.network.id, sample.address, 600);
    expect(r?.address).toBe(sample.address);
  });

  it("stores AI conversations per report and owner", async () => {
    const id = rid();
    await store.saveReport(mk(id), { visibility: "public", ownerHash: null });
    await store.addMessages(id, "o1", [{ role: "user", content: { question: "q1" } }, { role: "assistant", content: { answer: "a1" } }]);
    expect((await store.getMessages(id, "o1", 10)).map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(await store.getMessages(id, "o2", 10)).toEqual([]);
  });

  it("enforces the fixed-window rate limit atomically", async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => store.hit("t:key", 4, 60)));
    expect(results.filter((r) => r.allowed).length).toBe(4);
  });
});

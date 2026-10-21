import { AppError } from "@/lib/errors";
import { SEVERITY_ORDER, type Report, type Severity } from "@/lib/analysis/types";

export type Visibility = "public" | "private";

export interface ReportListItem {
  id: string;
  networkId: string;
  networkName: string;
  address: string;
  contractName: string | null;
  label: string;
  depth: Report["depth"];
  verified: boolean;
  visibility: Visibility;
  counts: Record<Severity, number>;
  createdAt: string;
  mine: boolean;
}

export interface ListQuery {
  search?: string;
  networkId?: string;
  label?: string;
  /** Only reports with at least one finding at this severity or worse. */
  minSeverity?: Severity;
  mine?: boolean;
  limit: number;
  offset: number;
}

export interface StoredMessage {
  role: "user" | "assistant";
  content: unknown;
  createdAt: string;
}

export interface ReportStore {
  kind: "postgres" | "memory";
  /** False for the in-memory store: data is lost on restart and not shared between instances. */
  persistent: boolean;
  saveReport(r: Report, opts: { visibility: Visibility; ownerHash: string | null }): Promise<void>;
  /** Returns null for missing reports AND for private reports the viewer does not own (no existence leak). */
  getReport(id: string, viewerHash: string | null): Promise<{ report: Report; visibility: Visibility; isOwner: boolean } | null>;
  findRecentPublic(networkId: string, address: string, maxAgeSeconds: number): Promise<Report | null>;
  listReports(q: ListQuery, viewerHash: string | null): Promise<ReportListItem[]>;
  setVisibility(id: string, visibility: Visibility, ownerHash: string): Promise<boolean>;
  addMessages(reportId: string, ownerHash: string, msgs: { role: "user" | "assistant"; content: unknown }[]): Promise<void>;
  getMessages(reportId: string, ownerHash: string, limit: number): Promise<StoredMessage[]>;
  /** Fixed-window limiter. */
  hit(key: string, limit: number, windowSeconds: number): Promise<{ allowed: boolean; retryAfter: number }>;
  recordUsage(kind: string, networkId: string | null, outcome: string): Promise<void>;
  ping(): Promise<boolean>;
}

export function findingCounts(r: Report): Record<Severity, number> {
  const c: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of r.findings) c[f.severity]++;
  return c;
}

export function maxSeverityIndex(r: Report): number {
  let m = 5;
  for (const f of r.findings) m = Math.min(m, SEVERITY_ORDER.indexOf(f.severity));
  return m;
}

function toItem(r: Report, visibility: Visibility, mine: boolean): ReportListItem {
  return {
    id: r.id,
    networkId: r.network.id,
    networkName: r.network.name,
    address: r.address,
    contractName: r.contractName,
    label: r.classification.label,
    depth: r.depth,
    verified: r.verification.verified,
    visibility,
    counts: findingCounts(r),
    createdAt: r.createdAt,
    mine,
  };
}

// ---- In-memory (development) ----------------------------------------------

interface MemRow {
  report: Report;
  visibility: Visibility;
  ownerHash: string | null;
}

export class MemoryStore implements ReportStore {
  kind = "memory" as const;
  persistent = false;
  private rows = new Map<string, MemRow>();
  private msgs = new Map<string, StoredMessage[]>();
  private limits = new Map<string, { start: number; count: number }>();
  private maxRows = 500;

  async saveReport(r: Report, opts: { visibility: Visibility; ownerHash: string | null }) {
    this.rows.set(r.id, { report: r, ...opts });
    if (this.rows.size > this.maxRows) this.rows.delete(this.rows.keys().next().value!);
  }
  async getReport(id: string, viewer: string | null) {
    const row = this.rows.get(id);
    if (!row) return null;
    const isOwner = Boolean(viewer && row.ownerHash === viewer);
    if (row.visibility === "private" && !isOwner) return null;
    return { report: row.report, visibility: row.visibility, isOwner };
  }
  async findRecentPublic(networkId: string, address: string, maxAge: number) {
    const cutoff = Date.now() - maxAge * 1000;
    let best: Report | null = null;
    for (const row of this.rows.values()) {
      const r = row.report;
      if (row.visibility === "public" && r.network.id === networkId && r.address === address && Date.parse(r.createdAt) >= cutoff) {
        if (!best || r.createdAt > best.createdAt) best = r;
      }
    }
    return best;
  }
  async listReports(q: ListQuery, viewer: string | null) {
    const s = q.search?.toLowerCase();
    const minIdx = q.minSeverity ? SEVERITY_ORDER.indexOf(q.minSeverity) : null;
    return [...this.rows.values()]
      .filter((row) => {
        const mine = Boolean(viewer && row.ownerHash === viewer);
        if (q.mine && !mine) return false;
        if (row.visibility === "private" && !mine) return false;
        const r = row.report;
        if (q.networkId && r.network.id !== q.networkId) return false;
        if (q.label && r.classification.label !== q.label) return false;
        if (minIdx !== null && maxSeverityIndex(r) > minIdx) return false;
        if (s && !(r.address.toLowerCase().includes(s) || (r.contractName ?? "").toLowerCase().includes(s))) return false;
        return true;
      })
      .sort((a, b) => b.report.createdAt.localeCompare(a.report.createdAt))
      .slice(q.offset, q.offset + q.limit)
      .map((row) => toItem(row.report, row.visibility, Boolean(viewer && row.ownerHash === viewer)));
  }
  async setVisibility(id: string, visibility: Visibility, ownerHash: string) {
    const row = this.rows.get(id);
    if (!row || row.ownerHash !== ownerHash) return false;
    row.visibility = visibility;
    return true;
  }
  async addMessages(reportId: string, ownerHash: string, msgs: { role: "user" | "assistant"; content: unknown }[]) {
    const k = `${reportId}|${ownerHash}`;
    const list = this.msgs.get(k) ?? [];
    for (const m of msgs) list.push({ ...m, createdAt: new Date().toISOString() });
    this.msgs.set(k, list.slice(-100));
  }
  async getMessages(reportId: string, ownerHash: string, limit: number) {
    return (this.msgs.get(`${reportId}|${ownerHash}`) ?? []).slice(-limit);
  }
  async hit(key: string, limit: number, windowSeconds: number) {
    const now = Date.now();
    const start = Math.floor(now / (windowSeconds * 1000)) * windowSeconds * 1000;
    const cur = this.limits.get(key);
    const entry = cur && cur.start === start ? cur : { start, count: 0 };
    entry.count++;
    this.limits.set(key, entry);
    if (this.limits.size > 10_000) for (const [k, v] of this.limits) if (v.start < start) this.limits.delete(k);
    return { allowed: entry.count <= limit, retryAfter: Math.ceil((start + windowSeconds * 1000 - now) / 1000) };
  }
  async recordUsage() {}
  async ping() {
    return true;
  }
}

// ---- PostgreSQL ---------------------------------------------------------------

type Queryable = { query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> };

export class PostgresStore implements ReportStore {
  kind = "postgres" as const;
  persistent = true;
  constructor(private db: Queryable) {}

  private async q(text: string, params: unknown[] = []) {
    try {
      return await this.db.query(text, params);
    } catch (e) {
      console.error("[unwrap] database error:", (e as Error).message);
      throw new AppError("STORAGE_ERROR", "The report database is unavailable. Try again shortly.");
    }
  }

  async saveReport(r: Report, opts: { visibility: Visibility; ownerHash: string | null }) {
    await this.q(
      `INSERT INTO reports (id, network_id, chain_id, address, contract_name, classification, depth, verified, visibility, owner_hash, max_severity, finding_counts, report, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [r.id, r.network.id, r.network.chainId, r.address, r.contractName, r.classification.label, r.depth, r.verification.verified, opts.visibility, opts.ownerHash, maxSeverityIndex(r), JSON.stringify(findingCounts(r)), JSON.stringify(r), r.createdAt],
    );
  }
  async getReport(id: string, viewer: string | null) {
    const { rows } = await this.q("SELECT report, visibility, owner_hash FROM reports WHERE id = $1", [id]);
    const row = rows[0];
    if (!row) return null;
    const isOwner = Boolean(viewer && row.owner_hash === viewer);
    if (row.visibility === "private" && !isOwner) return null;
    return { report: row.report as Report, visibility: row.visibility as Visibility, isOwner };
  }
  async findRecentPublic(networkId: string, address: string, maxAge: number) {
    const { rows } = await this.q(
      `SELECT report FROM reports WHERE network_id = $1 AND address = $2 AND visibility = 'public' AND created_at >= now() - ($3 || ' seconds')::interval ORDER BY created_at DESC LIMIT 1`,
      [networkId, address, String(maxAge)],
    );
    return (rows[0]?.report as Report) ?? null;
  }
  async listReports(q: ListQuery, viewer: string | null) {
    const where: string[] = [];
    const p: unknown[] = [];
    const add = (v: unknown) => {
      p.push(v);
      return `$${p.length}`;
    };
    const viewerParam = add(viewer ?? "");
    if (q.mine) where.push(`owner_hash = ${viewerParam}`);
    else where.push(`(visibility = 'public' OR owner_hash = ${viewerParam})`);
    if (q.networkId) where.push(`network_id = ${add(q.networkId)}`);
    if (q.label) where.push(`classification = ${add(q.label)}`);
    if (q.minSeverity) where.push(`max_severity <= ${add(SEVERITY_ORDER.indexOf(q.minSeverity))}`);
    if (q.search) {
      const like = add(`%${q.search.replace(/[%_\\]/g, (m) => `\\${m}`)}%`);
      where.push(`(address ILIKE ${like} OR contract_name ILIKE ${like})`);
    }
    const { rows } = await this.q(
      `SELECT report, visibility, owner_hash FROM reports WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ${add(q.limit)} OFFSET ${add(q.offset)}`,
      p,
    );
    return rows.map((r) => toItem(r.report as Report, r.visibility as Visibility, Boolean(viewer && r.owner_hash === viewer)));
  }
  async setVisibility(id: string, visibility: Visibility, ownerHash: string) {
    const { rowCount } = await this.q("UPDATE reports SET visibility = $1 WHERE id = $2 AND owner_hash = $3", [visibility, id, ownerHash]);
    return (rowCount ?? 0) > 0;
  }
  async addMessages(reportId: string, ownerHash: string, msgs: { role: "user" | "assistant"; content: unknown }[]) {
    for (const m of msgs) {
      await this.q("INSERT INTO ai_messages (report_id, owner_hash, role, content) VALUES ($1,$2,$3,$4)", [reportId, ownerHash, m.role, JSON.stringify(m.content)]);
    }
  }
  async getMessages(reportId: string, ownerHash: string, limit: number) {
    const { rows } = await this.q(
      "SELECT role, content, created_at FROM (SELECT * FROM ai_messages WHERE report_id = $1 AND owner_hash = $2 ORDER BY id DESC LIMIT $3) t ORDER BY id ASC",
      [reportId, ownerHash, limit],
    );
    return rows.map((r) => ({ role: r.role as "user" | "assistant", content: r.content, createdAt: new Date(r.created_at as string).toISOString() }));
  }
  async hit(key: string, limit: number, windowSeconds: number) {
    const { rows } = await this.q(
      `INSERT INTO rate_limits (key, window_start, count)
       VALUES ($1, to_timestamp(floor(extract(epoch FROM now()) / $2) * $2), 1)
       ON CONFLICT (key) DO UPDATE SET
         count = CASE WHEN rate_limits.window_start = EXCLUDED.window_start THEN rate_limits.count + 1 ELSE 1 END,
         window_start = EXCLUDED.window_start
       RETURNING count, extract(epoch FROM window_start) AS ws`,
      [key, windowSeconds],
    );
    const count = Number(rows[0]!.count);
    const ws = Number(rows[0]!.ws);
    return { allowed: count <= limit, retryAfter: Math.max(1, Math.ceil(ws + windowSeconds - Date.now() / 1000)) };
  }
  async recordUsage(kind: string, networkId: string | null, outcome: string) {
    await this.q("INSERT INTO usage_events (kind, network_id, outcome) VALUES ($1,$2,$3)", [kind, networkId, outcome]).catch(() => undefined);
  }
  async ping() {
    try {
      await this.db.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }
}

// ---- Factory ------------------------------------------------------------------

const g = globalThis as unknown as { __unwrapStore?: ReportStore };

export async function getStore(): Promise<ReportStore> {
  if (g.__unwrapStore) return g.__unwrapStore;
  const url = process.env.DATABASE_URL;
  if (url) {
    const { Pool } = await import("pg");
    const local = /localhost|127\.0\.0\.1/.test(url) || /sslmode=disable/.test(url);
    const pool = new Pool({
      connectionString: url,
      max: Number(process.env.DATABASE_POOL_MAX ?? 5),
      ssl: local ? false : { rejectUnauthorized: process.env.DATABASE_SSL_NO_VERIFY !== "1" },
      connectionTimeoutMillis: 8000,
      idleTimeoutMillis: 20000,
    });
    g.__unwrapStore = new PostgresStore(pool);
  } else {
    g.__unwrapStore = new MemoryStore();
  }
  return g.__unwrapStore;
}

/** For tests. */
export function setStoreForTesting(s: ReportStore | undefined) {
  g.__unwrapStore = s;
}

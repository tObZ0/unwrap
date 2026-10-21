import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { AppError, isAppError } from "@/lib/errors";
import { getStore } from "./store";

export const OWNER_COOKIE = "unwrap_owner";

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function newReportId(): string {
  return randomBytes(16).toString("base64url"); // 22 chars, 128 bits
}

export const REPORT_ID_RE = /^[A-Za-z0-9_-]{22}$/;

/** Reads the anonymous owner token; creates one if absent (caller must set the cookie). */
export function ownerFromRequest(req: NextRequest): { token: string; hash: string; isNew: boolean } {
  const existing = req.cookies.get(OWNER_COOKIE)?.value;
  if (existing && /^[A-Za-z0-9_-]{43}$/.test(existing)) return { token: existing, hash: sha256(existing), isNew: false };
  const token = randomBytes(32).toString("base64url");
  return { token, hash: sha256(token), isNew: true };
}

export function viewerHashFromCookie(value: string | undefined): string | null {
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? sha256(value) : null;
}

export function setOwnerCookie(res: NextResponse, owner: { token: string; isNew: boolean }) {
  if (!owner.isNew) return;
  res.cookies.set(OWNER_COOKIE, owner.token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
}

function clientKey(req: NextRequest): string {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
  return sha256(`${process.env.RATE_LIMIT_SALT ?? "unwrap-default-salt"}|${ip}`).slice(0, 32);
}

export async function rateLimit(req: NextRequest, route: string, limit: number, windowSeconds: number) {
  const store = await getStore();
  const r = await store.hit(`${route}:${clientKey(req)}`, limit, windowSeconds);
  if (!r.allowed) throw new AppError("RATE_LIMITED", `Too many requests. Try again in ${r.retryAfter} seconds.`, { retryAfter: r.retryAfter });
}

export async function readJson<T>(req: NextRequest, schema: z.ZodType<T>, maxBytes = 4096): Promise<T> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > maxBytes) throw new AppError("PAYLOAD_TOO_LARGE", "Request body is too large.");
  const text = await req.text();
  if (text.length > maxBytes) throw new AppError("PAYLOAD_TOO_LARGE", "Request body is too large.");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new AppError("INVALID_INPUT", "Request body must be valid JSON.");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new AppError("INVALID_INPUT", `Invalid request: ${issue?.path.join(".") || "body"} ${issue?.message ?? ""}`.trim());
  }
  return parsed.data;
}

export function errorResponse(e: unknown): NextResponse {
  if (isAppError(e)) {
    const res = NextResponse.json({ error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) } }, { status: e.status });
    const retry = e.details?.retryAfter;
    if (typeof retry === "number") res.headers.set("Retry-After", String(retry));
    return res;
  }
  console.error("[unwrap] unhandled error:", (e as Error)?.message ?? e);
  return NextResponse.json({ error: { code: "INTERNAL", message: "Something went wrong on our side. The error has been logged." } }, { status: 500 });
}

export function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new AppError("UPSTREAM_ERROR", message)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (err) => {
        clearTimeout(t);
        reject(err);
      },
    );
  });
}

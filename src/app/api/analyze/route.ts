import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse, ownerFromRequest, rateLimit, readJson, setOwnerCookie } from "@/lib/server/http";
import { runAnalysis } from "@/lib/server/services";

export const runtime = "nodejs";
export const maxDuration = 180;

const Body = z.object({
  network: z.string().min(1).max(40),
  address: z.string().min(1).max(64),
  visibility: z.enum(["public", "private"]).default("public"),
  refresh: z.boolean().default(false),
});

export async function POST(req: NextRequest) {
  const owner = ownerFromRequest(req);
  try {
    await rateLimit(req, "analyze", Number(process.env.RATE_LIMIT_ANALYZE_PER_MIN ?? 8), 60);
    const body = await readJson(req, Body);
    const { id, cached } = await runAnalysis({ ...body, ownerHash: owner.hash });
    const res = NextResponse.json({ id, cached });
    setOwnerCookie(res, owner);
    return res;
  } catch (e) {
    const res = errorResponse(e);
    setOwnerCookie(res, owner);
    return res;
  }
}

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse, OWNER_COOKIE, rateLimit, viewerHashFromCookie } from "@/lib/server/http";
import { getStore } from "@/lib/server/store";
import { AppError } from "@/lib/errors";

export const runtime = "nodejs";

const Query = z.object({
  q: z.string().max(80).optional(),
  network: z.string().max(40).optional(),
  type: z.string().max(80).optional(),
  severity: z.enum(["critical", "high", "medium", "low", "info"]).optional(),
  mine: z.enum(["1", "0"]).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).max(5000).default(0),
});

export async function GET(req: NextRequest) {
  try {
    await rateLimit(req, "list", 60, 60);
    const parsed = Query.safeParse(Object.fromEntries(req.nextUrl.searchParams));
    if (!parsed.success) throw new AppError("INVALID_INPUT", "Invalid search parameters.");
    const p = parsed.data;
    const store = await getStore();
    const viewer = viewerHashFromCookie(req.cookies.get(OWNER_COOKIE)?.value);
    const items = await store.listReports(
      { search: p.q?.trim() || undefined, networkId: p.network || undefined, label: p.type || undefined, minSeverity: p.severity, mine: p.mine === "1", limit: p.limit, offset: p.offset },
      viewer,
    );
    return NextResponse.json({ items, persistent: store.persistent, storage: store.kind });
  } catch (e) {
    return errorResponse(e);
  }
}

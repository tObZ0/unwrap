import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse, OWNER_COOKIE, readJson, REPORT_ID_RE, viewerHashFromCookie } from "@/lib/server/http";
import { getStore } from "@/lib/server/store";
import { AppError } from "@/lib/errors";

export const runtime = "nodejs";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    if (!REPORT_ID_RE.test(id)) throw new AppError("NOT_FOUND", "Report not found.");
    const store = await getStore();
    const found = await store.getReport(id, viewerHashFromCookie(req.cookies.get(OWNER_COOKIE)?.value));
    if (!found) throw new AppError("NOT_FOUND", "Report not found. It may be private, or it was stored in a development session that has since restarted.");
    return NextResponse.json({ report: found.report, visibility: found.visibility, isOwner: found.isOwner, persistent: store.persistent });
  } catch (e) {
    return errorResponse(e);
  }
}

const Patch = z.object({ visibility: z.enum(["public", "private"]) });

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    if (!REPORT_ID_RE.test(id)) throw new AppError("NOT_FOUND", "Report not found.");
    const viewer = viewerHashFromCookie(req.cookies.get(OWNER_COOKIE)?.value);
    if (!viewer) throw new AppError("FORBIDDEN", "Only the browser that created this report can change its visibility.");
    const body = await readJson(req, Patch, 256);
    const store = await getStore();
    const ok = await store.setVisibility(id, body.visibility, viewer);
    if (!ok) throw new AppError("FORBIDDEN", "Only the browser that created this report can change its visibility.");
    return NextResponse.json({ id, visibility: body.visibility });
  } catch (e) {
    return errorResponse(e);
  }
}

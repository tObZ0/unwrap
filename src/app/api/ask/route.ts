import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse, ownerFromRequest, rateLimit, readJson, REPORT_ID_RE, setOwnerCookie } from "@/lib/server/http";
import { getStore } from "@/lib/server/store";
import { postJson } from "@/lib/server/services";
import { aiConfigStatus, getAiProvider, type ChatMessage } from "@/lib/ai/provider";
import { askAboutReport, QUESTION_MAX, type AskResult } from "@/lib/ai/ask";
import { AppError } from "@/lib/errors";

export const runtime = "nodejs";
export const maxDuration = 60;

const Body = z.object({ reportId: z.string().regex(REPORT_ID_RE), question: z.string().min(3).max(QUESTION_MAX) });

async function loadReport(id: string, viewer: string) {
  const store = await getStore();
  const found = await store.getReport(id, viewer);
  if (!found) throw new AppError("NOT_FOUND", "Report not found.");
  return { store, report: found.report };
}

export async function POST(req: NextRequest) {
  const owner = ownerFromRequest(req);
  try {
    await rateLimit(req, "ask", Number(process.env.RATE_LIMIT_ASK_PER_MIN ?? 10), 60);
    const body = await readJson(req, Body, 2048);
    const { store, report } = await loadReport(body.reportId, owner.hash);
    const provider = getAiProvider(postJson);
    if (!provider) {
      const s = aiConfigStatus();
      throw new AppError("AI_NOT_CONFIGURED", `AI explanations are not configured on this deployment: ${(s.reason ?? "no provider").replace(/\.$/, "")}. The deterministic report is complete without it.`);
    }
    const prior = await store.getMessages(report.id, owner.hash, 6);
    const history: ChatMessage[] = prior.map((m) => ({
      role: m.role,
      content: m.role === "user" ? String((m.content as { question?: string }).question ?? "") : JSON.stringify({ answer: (m.content as AskResult).answer }),
    }));
    const result = await askAboutReport(report, body.question, history, provider);
    await store.addMessages(report.id, owner.hash, [
      { role: "user", content: { question: body.question } },
      { role: "assistant", content: result },
    ]);
    await store.recordUsage("ask", report.network.id, "ok");
    const res = NextResponse.json(result);
    setOwnerCookie(res, owner);
    return res;
  } catch (e) {
    const res = errorResponse(e);
    setOwnerCookie(res, owner);
    return res;
  }
}

export async function GET(req: NextRequest) {
  const owner = ownerFromRequest(req);
  try {
    const id = req.nextUrl.searchParams.get("reportId") ?? "";
    if (!REPORT_ID_RE.test(id)) throw new AppError("INVALID_INPUT", "reportId is required.");
    const { store } = await loadReport(id, owner.hash);
    const messages = owner.isNew ? [] : await store.getMessages(id, owner.hash, 40);
    const s = aiConfigStatus();
    return NextResponse.json({ messages, ai: { configured: s.configured, reason: s.reason ?? null } });
  } catch (e) {
    return errorResponse(e);
  }
}

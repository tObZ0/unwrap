import { NextResponse } from "next/server";
import { getStore } from "@/lib/server/store";
import { aiConfigStatus } from "@/lib/ai/provider";
import { slitherConfigured } from "@/lib/analysis/slither";
import { publicNetworks } from "@/lib/networks/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Health without credentials or URLs: only booleans and kinds. */
export async function GET() {
  const store = await getStore();
  const reachable = await store.ping();
  const ai = aiConfigStatus();
  const body = {
    status: reachable ? "ok" : "degraded",
    time: new Date().toISOString(),
    storage: { kind: store.kind, persistent: store.persistent, reachable },
    ai: { configured: ai.configured, provider: ai.provider },
    slither: { configured: slitherConfigured() },
    explorers: { etherscanV2KeyConfigured: Boolean(process.env.ETHERSCAN_API_KEY) },
    networks: publicNetworks().map((n) => ({ id: n.id, dedicatedRpcConfigured: n.dedicatedRpcConfigured })),
  };
  return NextResponse.json(body, { status: reachable ? 200 : 503 });
}

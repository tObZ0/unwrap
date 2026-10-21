import { NextResponse } from "next/server";
import { publicNetworks } from "@/lib/networks/registry";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ networks: publicNetworks() }, { headers: { "Cache-Control": "public, max-age=300" } });
}

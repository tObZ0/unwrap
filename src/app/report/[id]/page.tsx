import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { ReportView } from "@/components/report/report-view";
import { Notice } from "@/components/ui";
import { OWNER_COOKIE, REPORT_ID_RE, viewerHashFromCookie } from "@/lib/server/http";
import { getStore } from "@/lib/server/store";
import { isAppError } from "@/lib/errors";

export const dynamic = "force-dynamic";

async function load(id: string) {
  if (!REPORT_ID_RE.test(id)) return null;
  const store = await getStore();
  const viewer = viewerHashFromCookie((await cookies()).get(OWNER_COOKIE)?.value);
  const found = await store.getReport(id, viewer);
  return found ? { ...found, persistent: store.persistent } : null;
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  try {
    const found = await load((await params).id);
    if (!found || found.visibility === "private") return { title: "Report", robots: { index: false } };
    const r = found.report;
    return { title: `${r.contractName ?? r.address} on ${r.network.name}`, description: r.summary[0] };
  } catch {
    return { title: "Report" };
  }
}

export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let found: Awaited<ReturnType<typeof load>>;
  try {
    found = await load(id);
  } catch (e) {
    return (
      <div className="mx-auto max-w-3xl px-5 py-16">
        <Notice tone="error" title="This report could not be loaded">
          {isAppError(e) ? e.message : "The report store is unavailable."}
        </Notice>
      </div>
    );
  }
  if (!found) notFound();
  return <ReportView report={found.report} visibility={found.visibility} isOwner={found.isOwner} persistent={found.persistent} />;
}

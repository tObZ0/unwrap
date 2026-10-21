import type { Metadata } from "next";
import { ReportsBrowser } from "@/components/reports-browser";
import { publicNetworks } from "@/lib/networks/registry";
import { getStore } from "@/lib/server/store";

export const metadata: Metadata = { title: "Reports" };
export const dynamic = "force-dynamic";

export default async function ReportsPage() {
  const store = await getStore();
  return (
    <div className="mx-auto max-w-6xl px-5 py-12">
      <h1 className="font-display text-4xl font-bold tracking-tight">Reports</h1>
      <p className="mt-3 max-w-2xl text-fg-2">
        Contracts analysed on this deployment, newest first. This list contains only reports UNWRAP has actually generated here; it is not an index of every contract on a chain.
      </p>
      <ReportsBrowser networks={publicNetworks().map((n) => ({ id: n.id, name: n.name }))} persistent={store.persistent} />
    </div>
  );
}

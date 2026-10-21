import type { Metadata } from "next";
import { ReportView } from "@/components/report/report-view";
import type { Report } from "@/lib/analysis/types";
import sample from "@/data/sample-report.json";

export const metadata: Metadata = { title: "Sample report", description: "A real UNWRAP report generated against a deliberately unsafe test contract on a local development chain." };

export default function SamplePage() {
  return <ReportView report={sample as unknown as Report} sample />;
}

import Link from "next/link";

export default function ReportNotFound() {
  return (
    <div className="mx-auto max-w-2xl px-5 py-24">
      <h1 className="font-display text-3xl font-bold">Report not found</h1>
      <p className="mt-3 text-fg-2">
        The link may be wrong, the report may be private to the browser that created it, or it was held in a development server&apos;s memory and the server has restarted.
      </p>
      <Link href="/#analyse" className="mt-6 inline-flex rounded-md bg-fg px-4 py-2 font-semibold text-card hover:bg-accent">Analyse a contract</Link>
    </div>
  );
}

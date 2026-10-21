import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-2xl px-5 py-24">
      <h1 className="font-display text-3xl font-bold">Page not found</h1>
      <p className="mt-3 text-fg-2">There is nothing at this address.</p>
      <Link href="/" className="mt-6 inline-flex rounded-md bg-fg px-4 py-2 font-semibold text-card hover:bg-accent">Go to the homepage</Link>
    </div>
  );
}

"use client";

export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="mx-auto max-w-2xl px-5 py-24">
      <h1 className="font-display text-3xl font-bold">Something went wrong</h1>
      <p className="mt-3 text-fg-2">The page failed to render. The error has been logged on the server.</p>
      <button type="button" onClick={reset} className="mt-6 rounded-md bg-fg px-4 py-2 font-semibold text-card">Try again</button>
    </div>
  );
}

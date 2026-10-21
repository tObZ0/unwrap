/** Wordmark: an opened bracket pair, the contract "unwrapped". */
export function Logo({ className }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className ?? ""}`}>
      <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden fill="none">
        <path d="M8 2H3v18h5" stroke="var(--color-fg)" strokeWidth="2.2" strokeLinecap="square" />
        <path d="M14 2h5v18h-5" stroke="var(--color-accent)" strokeWidth="2.2" strokeLinecap="square" transform="rotate(-12 16 11)" />
      </svg>
      <span className="font-display text-[1.05rem] font-bold tracking-[0.08em]">UNWRAP</span>
    </span>
  );
}

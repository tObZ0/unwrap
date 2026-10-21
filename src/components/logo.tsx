/** Wordmark: a bracket pair prised open: the contract, unwrapped. */
export function Logo({ className }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className ?? ""}`}>
      <svg width="20" height="22" viewBox="0 0 20 22" aria-hidden fill="none">
        <path d="M7 2H2.5v18H7" stroke="var(--color-fg)" strokeWidth="2.6" strokeLinecap="square" />
        <path d="M13 2h4.5v18H13" stroke="var(--color-fg)" strokeWidth="2.6" strokeLinecap="square" transform="rotate(-14 16 12)" />
        <rect x="6.5" y="9" width="6" height="4" fill="var(--color-mark)" stroke="var(--color-fg)" strokeWidth="1.2" />
      </svg>
      <span className="font-display text-[1.05rem] font-extrabold tracking-[0.02em]">UNWRAP</span>
    </span>
  );
}

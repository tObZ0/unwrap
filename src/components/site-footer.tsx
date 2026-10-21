import Link from "next/link";
import { Logo } from "./logo";

/** Social links render only when configured: no dead buttons. */
function socials() {
  return [
    { label: "X", href: process.env.NEXT_PUBLIC_SOCIAL_X_URL },
    { label: "GitHub", href: process.env.NEXT_PUBLIC_SOCIAL_GITHUB_URL },
    { label: "Discord", href: process.env.NEXT_PUBLIC_SOCIAL_DISCORD_URL },
  ].filter((s): s is { label: string; href: string } => Boolean(s.href && /^https:\/\//.test(s.href)));
}

export function SiteFooter() {
  const links = socials();
  return (
    <footer className="border-t border-line-2 bg-bg-2">
      <div className="mx-auto grid max-w-[1180px] gap-10 px-5 py-12 sm:grid-cols-[1.4fr_1fr_1fr]">
        <div>
          <Logo />
          <p className="mt-3 max-w-sm text-sm text-fg-2">Smart contract intelligence for people who would rather not read the Solidity. Analysis is informational and is not a security audit or financial advice.</p>
        </div>
        <nav aria-label="Product" className="text-sm">
          <p className="mb-2 font-semibold">Product</p>
          <ul className="space-y-1.5 text-fg-2">
            <li><Link className="hover:text-fg" href="/#analyse">Analyse a contract</Link></li>
            <li><Link className="hover:text-fg" href="/reports">Saved reports</Link></li>
            <li><Link className="hover:text-fg" href="/sample">Sample report</Link></li>
            <li><Link className="hover:text-fg" href="/#limitations">Limitations</Link></li>
            <li><Link className="hover:text-fg" href="/#faq">FAQ</Link></li>
          </ul>
        </nav>
        <div className="text-sm">
          <p className="mb-2 font-semibold">Network</p>
          <ul className="space-y-1.5 text-fg-2">
            <li><a className="hover:text-fg" href="https://docs.robinhood.com/chain/" target="_blank" rel="noopener noreferrer">Robinhood Chain docs</a></li>
            <li><Link className="hover:text-fg" href="/api/health">Service status (JSON)</Link></li>
            {links.map((l) => (
              <li key={l.label}><a className="hover:text-fg" href={l.href} target="_blank" rel="noopener noreferrer">{l.label}</a></li>
            ))}
          </ul>
        </div>
      </div>
    </footer>
  );
}

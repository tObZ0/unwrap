"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Menu, X } from "lucide-react";
import { Logo } from "./logo";
import { cx } from "./ui";

const NAV = [
  { href: "/#analyse", label: "Analyse" },
  { href: "/reports", label: "Reports" },
  { href: "/sample", label: "Sample report" },
  { href: "/#how-it-works", label: "How it works" },
];

export function SiteHeader() {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-bg/90 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-5">
        <Link href="/" aria-label="UNWRAP home" onClick={() => setOpen(false)}>
          <Logo />
        </Link>
        <nav aria-label="Main" className="hidden gap-1 md:flex">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={cx("rounded-md px-3 py-1.5 text-sm text-fg-2 hover:bg-card hover:text-fg", path === n.href && "text-fg")}
              aria-current={path === n.href ? "page" : undefined}
            >
              {n.label}
            </Link>
          ))}
        </nav>
        <button type="button" className="rounded-md p-2 text-fg-2 hover:bg-card md:hidden" aria-expanded={open} aria-controls="mobile-nav" aria-label={open ? "Close menu" : "Open menu"} onClick={() => setOpen((v) => !v)}>
          {open ? <X size={20} aria-hidden /> : <Menu size={20} aria-hidden />}
        </button>
      </div>
      {open && (
        <nav id="mobile-nav" aria-label="Main" className="border-t border-line px-5 py-2 md:hidden">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} onClick={() => setOpen(false)} className="block rounded-md px-2 py-2.5 text-fg-2 hover:bg-card hover:text-fg">
              {n.label}
            </Link>
          ))}
        </nav>
      )}
    </header>
  );
}

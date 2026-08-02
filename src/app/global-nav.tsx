"use client";

import { usePathname } from "next/navigation";
import "./global-nav.css";

const links = [
  ["Operations", "/ops"],
  ["Workforce", "/ops/workforce"],
  ["Scheduler & Integrations", "/ops/integrations"],
  ["Bank Accounts", "/ops/bank-accounts"],
  ["Documents", "/"],
  ["Employee Hub", "/employee"],
  ["Tiki Clock", "/clock"],
] as const;

export default function GlobalNav() {
  const pathname = usePathname();
  if (pathname === "/clock" || pathname.startsWith("/employee")) return null;

  return <nav className="globalOwnerNav" aria-label="Corner Ops features">
    <a className="globalBrand" href="/ops">Corner Ops</a>
    <div className="globalNavLinks">
      {links.map(([label, href]) => {
        const active = href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
        return <a key={href} className={active ? "active" : ""} href={href}>{label}</a>;
      })}
    </div>
  </nav>;
}

"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import type { Business } from "@/lib/types";
import "./global-nav.css";

const links = [
  { label: "Operations", href: "/ops" },
  { label: "Reports", href: "/ops/reports" },
  { label: "Weather", href: "/ops/weather" },
  { label: "Attendance", href: "/ops/attendance" },
  { label: "Accounting Control", href: "/ops/accounting-control" },
  { label: "Cards & Receipts", href: "/ops/expense-control" },
  { label: "Payroll Control", href: "/ops/payroll-control" },
  { label: "Workforce", href: "/ops/workforce" },
  { label: "Employees", href: "/ops/employees" },
  { label: "Scheduler & Integrations", href: "/ops/integrations" },
  { label: "Bank Accounts", href: "/ops/bank-accounts" },
  { label: "Users", href: "/ops/users" },
  { label: "Documents", href: "/" },
  { label: "Employee Hub", href: "/employee" },
  { label: "Tiki Clock", href: "/clock", business: "Tiki" as const },
];

const businessNames: Business[] = ["Corner Deli", "Tiki"];

function validBusiness(value: string | null | undefined): value is Business {
  return businessNames.includes(value as Business);
}

export default function GlobalNav() {
  const pathname = usePathname();
  const [currentBusiness, setCurrentBusiness] = useState<Business>("Corner Deli");

  useEffect(() => {
    let restored = false;

    const savedBusiness = (): Business | null => {
      const saved = window.localStorage.getItem("corner-ops-business-theme");
      return validBusiness(saved) ? saved : null;
    };

    const applyTheme = (business: Business) => {
      document.documentElement.dataset.businessTheme = business;
      window.localStorage.setItem("corner-ops-business-theme", business);
      setCurrentBusiness(business);
    };

    function restore(): boolean {
      if (restored || pathname === "/clock") return false;

      if (pathname.startsWith("/employee")) {
        const select = document.querySelector<HTMLSelectElement>('select[name="business"]');
        const saved = savedBusiness();
        if (!select) return false;
        restored = true;
        if (saved && select.value !== saved) select.value = saved;
        if (saved) applyTheme(saved);
        return false;
      }

      const switcher = document.querySelector<HTMLElement>(
        ".businessSwitch, .wfBusinessSwitch, .businessPills",
      );
      if (!switcher) return false;

      restored = true;
      const saved = savedBusiness();
      if (!saved) return false;

      const selected = switcher
        .querySelector<HTMLElement>(".selected, .active")
        ?.textContent?.trim();
      if (selected === saved) return false;

      const button = Array.from(switcher.querySelectorAll<HTMLButtonElement>("button")).find(
        (item) => item.textContent?.trim() === saved,
      );
      if (!button) return false;

      applyTheme(saved);
      button.click();
      return true;
    }

    function detect(): Business {
      if (pathname === "/clock") return "Tiki";

      const selected = document
        .querySelector<HTMLElement>(
          ".businessSwitch .selected, .wfBusinessSwitch .selected, .businessPills .active",
        )
        ?.textContent?.trim();
      if (validBusiness(selected)) return selected;

      const select = document.querySelector<HTMLSelectElement>('select[name="business"]')?.value;
      if (validBusiness(select)) return select;

      return savedBusiness() || "Corner Deli";
    }

    function sync() {
      if (!restore()) applyTheme(detect());
    }

    function interaction(event: Event) {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const text = target.closest("button")?.textContent?.trim();
      if (validBusiness(text)) applyTheme(text);

      if (
        target instanceof HTMLSelectElement &&
        target.name === "business" &&
        validBusiness(target.value)
      ) {
        applyTheme(target.value);
      }
    }

    const observer = new MutationObserver(sync);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class"],
    });
    document.addEventListener("click", interaction, true);
    document.addEventListener("change", interaction, true);
    window.requestAnimationFrame(sync);

    return () => {
      observer.disconnect();
      document.removeEventListener("click", interaction, true);
      document.removeEventListener("change", interaction, true);
    };
  }, [pathname]);

  if (pathname === "/clock" || pathname.startsWith("/employee") || pathname === "/signin") {
    return null;
  }

  const visibleLinks = links.filter(
    (link) => !("business" in link) || link.business === currentBusiness,
  );

  return (
    <nav className="globalOwnerNav" aria-label="Corner Ops features">
      <a className="globalBrand" href="/ops">
        Corner Ops
      </a>
      <div className="globalNavLinks">
        {visibleLinks.map(({ label, href }) => {
          const active =
            href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
          return (
            <a key={href} className={active ? "active" : ""} href={href}>
              {label}
            </a>
          );
        })}
      </div>
    </nav>
  );
}

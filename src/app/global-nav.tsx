"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import type { Business } from "@/lib/types";
import "./global-nav.css";

type NavLink = {
  label: string;
  href: string;
  activePaths?: string[];
  exact?: boolean;
};

type NotificationSummary = {
  messages?: number;
};

const links: NavLink[] = [
  { label: "Reports", href: "/ops/reports", activePaths: ["/ops/reports", "/ops/weather"] },
  { label: "Banking", href: "/ops/banking", activePaths: ["/ops/banking", "/ops/accounting-control", "/ops/expense-control", "/ops/bank-accounts", "/ops/card-statements"] },
  { label: "Finance", href: "/ops/finance-operations", exact: true },
  { label: "Invoices", href: "/ops/finance-operations/invoice-ocr" },
  { label: "People", href: "/ops/people", activePaths: ["/ops/people", "/ops/workforce", "/ops/attendance", "/ops/payroll-control", "/ops/employees", "/ops/employment-forms", "/ops/rezku-monitor"] },
  { label: "Overtime", href: "/ops/overtime" },
  { label: "Messages", href: "/ops/messages" },
  { label: "Settings", href: "/ops/settings", activePaths: ["/ops/settings", "/ops/integrations", "/ops/users"] },
  { label: "Scan", href: "/scan" },
  { label: "Documents", href: "/" },
];

const businessNames: Business[] = ["Corner Deli", "Tiki"];
const hiddenNavPaths = ["/privacy", "/terms", "/sms-help", "/app"];

function validBusiness(value: string | null | undefined): value is Business {
  return businessNames.includes(value as Business);
}

function linkIsActive(pathname: string, link: NavLink): boolean {
  if (link.href === "/" || link.exact) return pathname === link.href;
  const paths = link.activePaths || [link.href];
  return paths.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

export default function GlobalNav() {
  const pathname = usePathname();
  const [currentBusiness, setCurrentBusiness] = useState<Business>("Corner Deli");
  const [open, setOpen] = useState(false);
  const [unreadMessages, setUnreadMessages] = useState(0);
  const navHidden = pathname === "/clock"
    || pathname === "/scan"
    || pathname.startsWith("/employee")
    || pathname.startsWith("/deli-board")
    || pathname === "/signin"
    || hiddenNavPaths.includes(pathname);
  const themeEffectsHidden = pathname === "/clock"
    || pathname.startsWith("/deli-board")
    || pathname === "/signin"
    || hiddenNavPaths.includes(pathname);

  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (navHidden) return;
    let cancelled = false;

    async function refreshNotifications() {
      if (document.visibilityState === "hidden") return;
      try {
        const response = await fetch("/api/messages?summary=nav", { cache: "no-store" });
        if (!response.ok) return;
        const payload = await response.json() as NotificationSummary;
        if (!cancelled) setUnreadMessages(Math.max(0, Number(payload.messages || 0)));
      } catch {
        // Navigation remains usable when notification polling is unavailable.
      }
    }

    function onVisibilityChange() {
      if (document.visibilityState === "visible") void refreshNotifications();
    }

    void refreshNotifications();
    const interval = window.setInterval(() => void refreshNotifications(), 90_000);
    window.addEventListener("focus", refreshNotifications);
    window.addEventListener("corner-ops-notifications-refresh", refreshNotifications);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshNotifications);
      window.removeEventListener("corner-ops-notifications-refresh", refreshNotifications);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [navHidden]);

  useEffect(() => {
    if (themeEffectsHidden) return;
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
      if (restored) return false;

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

      const selected = switcher.querySelector<HTMLElement>(".selected, .active")?.textContent?.trim();
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
      const selected = document
        .querySelector<HTMLElement>(".businessSwitch .selected, .wfBusinessSwitch .selected, .businessPills .active")
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
      if (target instanceof HTMLSelectElement && target.name === "business" && validBusiness(target.value)) {
        applyTheme(target.value);
      }
    }

    const observer = new MutationObserver(sync);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
    document.addEventListener("click", interaction, true);
    document.addEventListener("change", interaction, true);
    window.requestAnimationFrame(sync);

    return () => {
      observer.disconnect();
      document.removeEventListener("click", interaction, true);
      document.removeEventListener("change", interaction, true);
    };
  }, [pathname, themeEffectsHidden]);

  if (navHidden) return null;

  return (
    <nav className={`globalOwnerNav ${open ? "menuOpen" : ""}`} aria-label="Corner Ops features" data-business={currentBusiness}>
      <div className="globalNavTopline">
        <a className="globalBrand" href="/ops/people">Corner Ops</a>
        <button className="globalMenuButton" type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          {open ? "Close" : "Menu"}
        </button>
      </div>
      <div className="globalNavLinks">
        {links.map((link) => {
          const count = link.href === "/ops/messages" ? unreadMessages : 0;
          return <a key={link.href} className={linkIsActive(pathname, link) ? "active" : ""} href={link.href}>
            <span>{link.label}</span>
            {count > 0 && <span className="globalNavBadge" aria-label={`${count} unread message${count === 1 ? "" : "s"}`}>
              {count > 99 ? "99+" : count}
            </span>}
          </a>;
        })}
      </div>
    </nav>
  );
}

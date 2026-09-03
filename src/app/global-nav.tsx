"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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

type BusinessChangeDetail = {
  business: Business;
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
const explicitLegacySwitcherSelector = [
  ".businessSwitch",
  ".wfBusinessSwitch",
  ".businessPills",
  ".messageBusinessTabs",
  '[data-business-switcher="page"]',
].join(", ");

function validBusiness(value: string | null | undefined): value is Business {
  return businessNames.includes(value as Business);
}

function normalizedLabel(value: string | null | undefined): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function buttonBusiness(button: HTMLButtonElement | null): Business | null {
  const label = normalizedLabel(button?.textContent);
  return validBusiness(label) ? label : null;
}

function directBusinessButtons(element: HTMLElement): HTMLButtonElement[] {
  return Array.from(element.children).filter((child): child is HTMLButtonElement => {
    return child instanceof HTMLButtonElement && Boolean(buttonBusiness(child));
  });
}

function legacyBusinessSwitchers(): HTMLElement[] {
  const explicit = Array.from(document.querySelectorAll<HTMLElement>(explicitLegacySwitcherSelector));
  const inferred = Array.from(document.querySelectorAll<HTMLElement>("main div, main nav, main header, main section"))
    .filter((element) => {
      const allDirectButtons = Array.from(element.children)
        .filter((child): child is HTMLButtonElement => child instanceof HTMLButtonElement);
      if (allDirectButtons.length < 2 || allDirectButtons.length > 4) return false;
      const businesses = new Set(directBusinessButtons(element).map((button) => buttonBusiness(button)));
      return businesses.has("Corner Deli") && businesses.has("Tiki");
    });
  return Array.from(new Set([...explicit, ...inferred]));
}

function markLegacyBusinessSwitchers(): HTMLElement[] {
  const switchers = legacyBusinessSwitchers();
  for (const switcher of switchers) switcher.dataset.legacyBusinessSwitcher = "true";
  return switchers;
}

function selectedSwitcherBusiness(switcher: HTMLElement): Business | null {
  const selectedButton = switcher.querySelector<HTMLButtonElement>(
    'button.selected, button.active, button[aria-pressed="true"]',
  );
  const selected = buttonBusiness(selectedButton);
  if (selected) return selected;
  const select = switcher.querySelector<HTMLSelectElement>('select[name="business"]');
  return validBusiness(select?.value) ? select.value : null;
}

function detectPageBusiness(): Business | null {
  for (const switcher of markLegacyBusinessSwitchers()) {
    const selected = selectedSwitcherBusiness(switcher);
    if (selected) return selected;
  }
  return null;
}

function synchronizeLegacyBusinessControls(business: Business): boolean {
  let found = false;
  for (const switcher of markLegacyBusinessSwitchers()) {
    const button = Array.from(switcher.querySelectorAll<HTMLButtonElement>("button"))
      .find((candidate) => buttonBusiness(candidate) === business);
    if (!button) continue;
    found = true;
    if (selectedSwitcherBusiness(switcher) !== business && !button.disabled) button.click();
  }
  return found;
}

function requestedBusiness(): Business | null {
  const requested = new URLSearchParams(window.location.search).get("business");
  return validBusiness(requested) ? requested : null;
}

function linkIsActive(pathname: string, link: NavLink): boolean {
  if (link.href === "/" || link.exact) return pathname === link.href;
  const paths = link.activePaths || [link.href];
  return paths.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

export default function GlobalNav() {
  const pathname = usePathname();
  const navRef = useRef<HTMLElement | null>(null);
  const currentBusinessRef = useRef<Business>("Corner Deli");
  const [currentBusiness, setCurrentBusiness] = useState<Business>("Corner Deli");
  const [open, setOpen] = useState(false);
  const [unreadMessages, setUnreadMessages] = useState(0);
  const navHidden = pathname === "/clock"
    || pathname === "/scan"
    || pathname.startsWith("/employee")
    || pathname.startsWith("/deli-board")
    || pathname === "/signin"
    || hiddenNavPaths.includes(pathname);

  const applyBusiness = useCallback((business: Business, persist: boolean) => {
    currentBusinessRef.current = business;
    document.documentElement.dataset.businessTheme = business;
    if (persist) window.localStorage.setItem("corner-ops-business-theme", business);
    setCurrentBusiness(business);
  }, []);

  const chooseBusiness = useCallback((business: Business) => {
    applyBusiness(business, true);
    synchronizeLegacyBusinessControls(business);
    window.dispatchEvent(new CustomEvent<BusinessChangeDetail>("corner-ops-business-change", {
      detail: { business },
    }));
  }, [applyBusiness]);

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
    if (navHidden) {
      document.documentElement.removeAttribute("data-global-business-switcher");
      return;
    }

    document.documentElement.dataset.globalBusinessSwitcher = "true";
    const saved = window.localStorage.getItem("corner-ops-business-theme");
    const initialBusiness = requestedBusiness()
      || (validBusiness(saved) ? saved : null)
      || detectPageBusiness()
      || currentBusinessRef.current;
    applyBusiness(initialBusiness, false);

    let frame = 0;
    const synchronize = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        synchronizeLegacyBusinessControls(currentBusinessRef.current);
      });
    };

    synchronize();
    const observer = new MutationObserver(synchronize);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class", "aria-pressed"],
    });

    const onBusinessChange = (event: Event) => {
      const business = (event as CustomEvent<BusinessChangeDetail>).detail?.business;
      if (!validBusiness(business)) return;
      applyBusiness(business, false);
      synchronize();
    };
    window.addEventListener("corner-ops-business-change", onBusinessChange);

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("corner-ops-business-change", onBusinessChange);
      document.documentElement.removeAttribute("data-global-business-switcher");
    };
  }, [applyBusiness, navHidden, pathname]);

  useEffect(() => {
    if (navHidden) {
      document.documentElement.style.removeProperty("--global-owner-nav-height");
      return;
    }
    const nav = navRef.current;
    if (!nav) return;
    let frame = 0;
    const updateHeight = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const height = Math.max(0, Math.ceil(nav.getBoundingClientRect().height));
        document.documentElement.style.setProperty("--global-owner-nav-height", `${height}px`);
        window.dispatchEvent(new Event("corner-ops-layout-change"));
      });
    };
    updateHeight();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateHeight);
    observer?.observe(nav);
    window.addEventListener("resize", updateHeight);
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", updateHeight);
      document.documentElement.style.removeProperty("--global-owner-nav-height");
      window.dispatchEvent(new Event("corner-ops-layout-change"));
    };
  }, [navHidden]);

  if (navHidden) return null;

  return (
    <nav ref={navRef} className={`globalOwnerNav ${open ? "menuOpen" : ""}`} aria-label="Corner Ops features" data-business={currentBusiness}>
      <div className="globalNavTopline">
        <a className="globalBrand" href="/ops/people">Corner Ops</a>
        <div className="globalBusinessSwitch" role="group" aria-label="Current business">
          {businessNames.map((business) => (
            <button
              key={business}
              type="button"
              className={currentBusiness === business ? "active" : ""}
              aria-pressed={currentBusiness === business}
              onClick={() => chooseBusiness(business)}
            >
              {business}
            </button>
          ))}
        </div>
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

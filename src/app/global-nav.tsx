"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import type { Business } from "@/lib/types";
import "./global-nav.css";

const links = [
  ["Operations", "/ops"],
  ["Workforce", "/ops/workforce"],
  ["Employees", "/ops/employees"],
  ["Scheduler & Integrations", "/ops/integrations"],
  ["Bank Accounts", "/ops/bank-accounts"],
  ["Documents", "/"],
  ["Employee Hub", "/employee"],
  ["Tiki Clock", "/clock"],
] as const;

const businessNames: Business[] = ["Corner Deli", "Tiki"];

function validBusiness(value: string | null | undefined): value is Business {
  return businessNames.includes(value as Business);
}

export default function GlobalNav() {
  const pathname = usePathname();

  useEffect(() => {
    let restoredPageSelection = false;

    function savedBusiness(): Business | null {
      const saved = window.localStorage.getItem("corner-ops-business-theme");
      return validBusiness(saved) ? saved : null;
    }

    function applyTheme(business: Business) {
      document.documentElement.dataset.businessTheme = business;
      window.localStorage.setItem("corner-ops-business-theme", business);
    }

    function restoreBusinessControl(): boolean {
      if (restoredPageSelection || pathname === "/clock") return false;

      if (pathname.startsWith("/employee")) {
        const employeeLabel = Array.from(document.querySelectorAll<HTMLElement>(".empEyebrow"))
          .map((element) => element.textContent?.trim())
          .find(validBusiness);
        if (employeeLabel) {
          restoredPageSelection = true;
          return false;
        }

        const select = document.querySelector<HTMLSelectElement>('select[name="business"]');
        const saved = savedBusiness();
        if (!select) return false;
        restoredPageSelection = true;
        if (saved && select.value !== saved) select.value = saved;
        if (saved) applyTheme(saved);
        return false;
      }

      const switcher = document.querySelector<HTMLElement>(".businessSwitch, .wfBusinessSwitch");
      if (!switcher) return false;
      restoredPageSelection = true;

      const saved = savedBusiness();
      if (!saved) return false;
      const selected = switcher.querySelector<HTMLElement>(".selected")?.textContent?.trim();
      if (selected === saved) return false;

      const matchingButton = Array.from(switcher.querySelectorAll<HTMLButtonElement>("button"))
        .find((button) => button.textContent?.trim() === saved);
      if (!matchingButton) return false;

      applyTheme(saved);
      matchingButton.click();
      return true;
    }

    function detectBusiness(): Business {
      if (pathname === "/clock") return "Tiki";

      const selected = document.querySelector<HTMLElement>(
        ".businessSwitch .selected, .wfBusinessSwitch .selected",
      );
      const selectedText = selected?.textContent?.trim();
      if (validBusiness(selectedText)) return selectedText;

      if (pathname.startsWith("/employee")) {
        const employeeLabel = Array.from(document.querySelectorAll<HTMLElement>(".empEyebrow"))
          .map((element) => element.textContent?.trim())
          .find(validBusiness);
        if (employeeLabel) return employeeLabel;

        const loginBusiness = document.querySelector<HTMLSelectElement>('select[name="business"]')?.value;
        if (validBusiness(loginBusiness)) return loginBusiness;
      }

      return savedBusiness() || "Corner Deli";
    }

    function synchronizeTheme() {
      if (restoreBusinessControl()) return;
      applyTheme(detectBusiness());
    }

    function handleInteraction(event: Event) {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const businessButton = target.closest("button");
      const buttonText = businessButton?.textContent?.trim();
      if (validBusiness(buttonText)) {
        applyTheme(buttonText);
        return;
      }

      if (target instanceof HTMLSelectElement && target.name === "business" && validBusiness(target.value)) {
        applyTheme(target.value);
      }
    }

    const observer = new MutationObserver(synchronizeTheme);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class"],
    });
    document.addEventListener("click", handleInteraction, true);
    document.addEventListener("change", handleInteraction, true);
    window.requestAnimationFrame(synchronizeTheme);

    return () => {
      observer.disconnect();
      document.removeEventListener("click", handleInteraction, true);
      document.removeEventListener("change", handleInteraction, true);
    };
  }, [pathname]);

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

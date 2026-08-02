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
    function applyTheme(business: Business) {
      document.documentElement.dataset.businessTheme = business;
      window.localStorage.setItem("corner-ops-business-theme", business);
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

      const saved = window.localStorage.getItem("corner-ops-business-theme");
      return validBusiness(saved) ? saved : "Corner Deli";
    }

    function synchronizeTheme() {
      applyTheme(detectBusiness());
    }

    synchronizeTheme();
    const observer = new MutationObserver(synchronizeTheme);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class"],
    });

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

    document.addEventListener("click", handleInteraction, true);
    document.addEventListener("change", handleInteraction, true);
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

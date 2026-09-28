"use client";

import { useEffect } from "react";
import { employeePinLabel, employeePinPattern } from "@/lib/employee-pin";
import type { Business } from "@/lib/types";

function isBusiness(value: string): value is Business {
  return value === "Corner Deli" || value === "Tiki";
}

function requestedBusiness(): Business | null {
  const value = new URLSearchParams(window.location.search).get("business");
  return value && isBusiness(value) ? value : null;
}

function pinIsComplete(business: Business, value: string): boolean {
  return business === "Corner Deli" ? /^\d{4,5}$/.test(value) : /^\d{5}$/.test(value);
}

export default function EmployeePinController() {
  useEffect(() => {
    function sync() {
      const linkedBusiness = requestedBusiness();
      for (const form of document.querySelectorAll<HTMLFormElement>("form")) {
        const businessSelect = form.querySelector<HTMLSelectElement>('select[name="business"]');
        const pinInput = form.querySelector<HTMLInputElement>('input[name="pin"]');
        if (!businessSelect || !pinInput) continue;

        if (linkedBusiness && businessSelect.value !== linkedBusiness) {
          businessSelect.value = linkedBusiness;
          businessSelect.dispatchEvent(new Event("change", { bubbles: true }));
        }
        if (!isBusiness(businessSelect.value)) continue;

        const business = businessSelect.value;
        const minLength = business === "Corner Deli" ? 4 : 5;
        const maxLength = 5;
        // New Corner Deli employees are issued four-digit PINs, but Employee Hub keeps accepting
        // legacy five-digit Deli PINs until those employees are changed over.
        pinInput.pattern = business === "Corner Deli" ? "\\d{4,5}" : employeePinPattern(business);
        pinInput.maxLength = maxLength;
        pinInput.minLength = minLength;
        pinInput.placeholder = business === "Corner Deli" ? "4 digits" : "5 digits";
        pinInput.setAttribute("aria-label", employeePinLabel(business));

        const label = pinInput.closest("label");
        const firstNode = label?.childNodes[0];
        if (firstNode?.nodeType === Node.TEXT_NODE) {
          firstNode.textContent = employeePinLabel(business);
        }

        const submitButton = form.querySelector<HTMLButtonElement>('button[type="submit"], button:not([type])');
        if (submitButton) {
          const signingIn = submitButton.textContent?.includes("Signing in") ?? false;
          submitButton.disabled = signingIn || !pinIsComplete(business, pinInput.value);
        }
      }
    }

    const scheduleSync = () => window.requestAnimationFrame(sync);
    const observer = new MutationObserver(scheduleSync);
    observer.observe(document.body, { subtree: true, childList: true });
    document.addEventListener("change", scheduleSync, true);
    document.addEventListener("input", scheduleSync, true);
    scheduleSync();

    return () => {
      observer.disconnect();
      document.removeEventListener("change", scheduleSync, true);
      document.removeEventListener("input", scheduleSync, true);
    };
  }, []);

  return null;
}

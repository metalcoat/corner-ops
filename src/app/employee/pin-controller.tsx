"use client";

import { useEffect } from "react";
import { employeePinLabel, employeePinLength, employeePinPattern } from "@/lib/employee-pin";
import type { Business } from "@/lib/types";

function isBusiness(value: string): value is Business {
  return value === "Corner Deli" || value === "Tiki";
}

export default function EmployeePinController() {
  useEffect(() => {
    function sync() {
      for (const form of document.querySelectorAll<HTMLFormElement>("form")) {
        const businessSelect = form.querySelector<HTMLSelectElement>('select[name="business"]');
        const pinInput = form.querySelector<HTMLInputElement>('input[name="pin"]');
        if (!businessSelect || !pinInput || !isBusiness(businessSelect.value)) continue;

        const business = businessSelect.value;
        const length = employeePinLength(business);
        pinInput.pattern = employeePinPattern(business);
        pinInput.maxLength = length;
        pinInput.minLength = length;
        pinInput.placeholder = `${length} digits`;
        pinInput.setAttribute("aria-label", employeePinLabel(business));

        const label = pinInput.closest("label");
        const firstNode = label?.childNodes[0];
        if (firstNode?.nodeType === Node.TEXT_NODE) {
          firstNode.textContent = employeePinLabel(business);
        }
      }
    }

    const observer = new MutationObserver(sync);
    observer.observe(document.body, { subtree: true, childList: true });
    document.addEventListener("change", sync, true);
    window.requestAnimationFrame(sync);

    return () => {
      observer.disconnect();
      document.removeEventListener("change", sync, true);
    };
  }, []);

  return null;
}

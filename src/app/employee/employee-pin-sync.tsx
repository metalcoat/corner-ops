"use client";

import { useEffect } from "react";

function applyPinRules() {
  const select = document.querySelector<HTMLSelectElement>('select[name="business"]');
  const input = document.querySelector<HTMLInputElement>('input[name="pin"]');
  if (!select || !input) return;
  const length = select.value === "Corner Deli" ? 4 : 5;
  input.pattern = `\\d{${length}}`;
  input.minLength = length;
  input.maxLength = length;
  input.setAttribute("aria-label", `${length}-digit PIN`);
  const label = input.closest("label");
  if (label?.firstChild?.nodeType === Node.TEXT_NODE) {
    label.firstChild.textContent = `${length === 4 ? "Four" : "Five"}-digit PIN`;
  }
}

export default function EmployeePinSync() {
  useEffect(() => {
    applyPinRules();
    const listener = (event: Event) => {
      const target = event.target;
      if (target instanceof HTMLSelectElement && target.name === "business") applyPinRules();
    };
    document.addEventListener("change", listener, true);
    const observer = new MutationObserver(applyPinRules);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      document.removeEventListener("change", listener, true);
      observer.disconnect();
    };
  }, []);
  return null;
}

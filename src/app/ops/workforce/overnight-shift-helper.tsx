"use client";

import { useEffect } from "react";

function minutes(value: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : -1;
}

function fieldLabel(form: HTMLFormElement, name: string): HTMLLabelElement | undefined {
  return Array.from(form.querySelectorAll<HTMLLabelElement>("label")).find((label) =>
    String(label.childNodes[0]?.textContent || "").trim() === name,
  );
}

function refreshOvernightLabels() {
  const form = document.querySelector<HTMLFormElement>(".scheduleEditForm");
  if (!form) return;

  const startLabel = fieldLabel(form, "Start");
  const endLabel = fieldLabel(form, "End");
  const startSelect = startLabel?.querySelector<HTMLSelectElement>("select");
  const endSelect = endLabel?.querySelector<HTMLSelectElement>("select");
  if (!startSelect || !endSelect || !endLabel) return;

  const startMinutes = minutes(startSelect.value);
  const selectedEndMinutes = minutes(endSelect.value);

  for (const option of Array.from(endSelect.options)) {
    const baseLabel = option.dataset.baseTimeLabel || String(option.textContent || "").replace(/ · next day$/, "");
    option.dataset.baseTimeLabel = baseLabel;
    const nextDay = startMinutes >= 0 && minutes(option.value) <= startMinutes;
    const nextLabel = `${baseLabel}${nextDay ? " · next day" : ""}`;
    if (option.textContent !== nextLabel) option.textContent = nextLabel;
  }

  let hint = endLabel.querySelector<HTMLSpanElement>("[data-overnight-shift-hint]");
  if (!hint) {
    hint = document.createElement("span");
    hint.dataset.overnightShiftHint = "true";
    hint.style.display = "block";
    hint.style.marginTop = "5px";
    hint.style.fontSize = ".78rem";
    hint.style.fontWeight = "700";
    hint.style.color = "var(--muted)";
    endLabel.appendChild(hint);
  }

  const selected = endSelect.selectedOptions[0];
  const selectedLabel = selected?.dataset.baseTimeLabel || selected?.textContent || endSelect.value;
  const overnight = startMinutes >= 0 && selectedEndMinutes >= 0 && selectedEndMinutes <= startMinutes;
  hint.textContent = overnight
    ? `Ends ${selectedLabel} on the following day.`
    : `Ends ${selectedLabel} on the selected day.`;
}

export default function OvernightShiftHelper() {
  useEffect(() => {
    let frame = 0;
    const scheduleRefresh = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(refreshOvernightLabels);
    };

    const observer = new MutationObserver(scheduleRefresh);
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener("change", scheduleRefresh, true);
    scheduleRefresh();

    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("change", scheduleRefresh, true);
      observer.disconnect();
    };
  }, []);

  return null;
}

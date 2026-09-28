"use client";

import { responseMessage } from "@/app/client-http";
import { FormEvent, useEffect, useMemo, useState } from "react";
import type { Business } from "@/lib/types";
import "./missing-shift-panel.css";

type Employee = {
  id: string;
  name: string;
  position: string;
};

type SetupPayload = {
  business: Business;
  employees: Employee[];
  positions: string[];
};

type CreatedShift = {
  id: string;
  business: Business;
  employeeName: string;
  source: string;
  hours: number;
};

const BUSINESS_NAMES: Business[] = ["Corner Deli", "Tiki"];
const SAVED_NOTICE_KEY = "corner-ops-missing-shift-notice";

function validBusiness(value: string | null | undefined): value is Business {
  return BUSINESS_NAMES.includes(value as Business);
}

function easternDateKey() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function detectPayrollBusiness(): Business {
  const active = Array.from(document.querySelectorAll<HTMLElement>("main.controlPage .businessPills button.active"))
    .map((button) => button.textContent?.trim() || "")
    .find(validBusiness);
  if (active) return active;
  const saved = window.localStorage.getItem("corner-ops-business-theme");
  return validBusiness(saved) ? saved : "Corner Deli";
}

export default function MissingShiftPanel() {
  const [business, setBusiness] = useState<Business>("Corner Deli");
  const [open, setOpen] = useState(false);
  const [setup, setSetup] = useState<SetupPayload | null>(null);
  const [employeeId, setEmployeeId] = useState("");
  const [position, setPosition] = useState("");
  const [date, setDate] = useState(easternDateKey());
  const [clockIn, setClockIn] = useState("");
  const [clockOut, setClockOut] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadingEmployees, setLoadingEmployees] = useState(false);

  useEffect(() => {
    const savedNotice = window.sessionStorage.getItem(SAVED_NOTICE_KEY);
    if (savedNotice) {
      window.sessionStorage.removeItem(SAVED_NOTICE_KEY);
      setNotice(savedNotice);
      setOpen(true);
    }

    const syncBusiness = () => setBusiness(detectPayrollBusiness());
    const delayedSync = () => window.setTimeout(syncBusiness, 0);
    const observer = new MutationObserver(syncBusiness);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class"],
    });
    document.addEventListener("click", delayedSync, true);
    syncBusiness();
    return () => {
      observer.disconnect();
      document.removeEventListener("click", delayedSync, true);
    };
  }, []);

  useEffect(() => {
    setSetup(null);
    setEmployeeId("");
    setPosition("");
    setNotice("");
    if (!open) return;

    let cancelled = false;
    setLoadingEmployees(true);
    fetch(`/api/workforce/manual-time-entry?business=${encodeURIComponent(business)}`, {
      cache: "no-store",
      headers: { "Cache-Control": "no-cache" },
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(await responseMessage(response));
        return response.json() as Promise<SetupPayload>;
      })
      .then((payload) => {
        if (!cancelled) setSetup(payload);
      })
      .catch((error) => {
        if (!cancelled) setNotice(error instanceof Error ? error.message : "Employees could not be loaded.");
      })
      .finally(() => {
        if (!cancelled) setLoadingEmployees(false);
      });
    return () => {
      cancelled = true;
    };
  }, [business, open]);

  const selectedEmployee = useMemo(
    () => setup?.employees.find((employee) => employee.id === employeeId) || null,
    [employeeId, setup?.employees],
  );

  useEffect(() => {
    if (!selectedEmployee) return;
    setPosition(selectedEmployee.position || setup?.positions[0] || (business === "Tiki" ? "Bartender" : ""));
  }, [business, selectedEmployee, setup?.positions]);

  async function addShift(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/workforce/manual-time-entry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          business,
          employeeId,
          position,
          date,
          clockInWall: clockIn,
          clockOutWall: clockOut,
          note: new FormData(event.currentTarget).get("note"),
        }),
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      const created = await response.json() as CreatedShift;
      const crossesMidnight = clockOut <= clockIn;
      const message = `Added ${created.employeeName}: ${date} at ${clockIn} to ${crossesMidnight ? "the next day at " : ""}${clockOut} (${Number(created.hours || 0).toFixed(2)} hours). Payroll has been recalculated from the saved shift.`;
      window.sessionStorage.setItem(SAVED_NOTICE_KEY, message);
      window.location.reload();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The missing shift could not be added.");
      setBusy(false);
    }
  }

  return <section className="missingShiftShell" aria-label="Add a completely missing payroll shift">
    <div className={`missingShiftCard ${open ? "isOpen" : ""}`}>
      <button className="missingShiftToggle" type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span><strong>Add completely missing shift</strong><small>Create both the clock-in and clock-out directly from Payroll Control.</small></span>
        <span aria-hidden="true">{open ? "Close" : "+ Add shift"}</span>
      </button>

      {open && <div className="missingShiftBody">
        <p className="missingShiftBusiness">Adding to <strong>{business}</strong>. Use the business buttons on Payroll Control to switch locations.</p>
        {notice && <div className="missingShiftNotice" role="status" aria-live="polite">{notice}</div>}

        <form className="missingShiftForm" onSubmit={addShift}>
          <label>Employee
            <select value={employeeId} onChange={(event) => setEmployeeId(event.target.value)} required disabled={busy || loadingEmployees}>
              <option value="">{loadingEmployees ? "Loading employees…" : "Choose employee"}</option>
              {setup?.employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}
            </select>
          </label>
          <label>Position
            {business === "Corner Deli" ? <select value={position} onChange={(event) => setPosition(event.target.value)} required disabled={busy}>
              <option value="">Choose position</option>
              {setup?.positions.map((item) => <option key={item} value={item}>{item}</option>)}
            </select> : <input value={position} onChange={(event) => setPosition(event.target.value)} required disabled={busy} placeholder="Bartender" />}
          </label>
          <label>Shift date <small>Eastern Time</small>
            <input type="date" value={date} onChange={(event) => setDate(event.target.value)} required disabled={busy} />
          </label>
          <label>Clock in <small>Eastern Time</small>
            <input type="time" value={clockIn} onChange={(event) => setClockIn(event.target.value)} required disabled={busy} />
          </label>
          <label>Clock out <small>Eastern Time</small>
            <input type="time" value={clockOut} onChange={(event) => setClockOut(event.target.value)} required disabled={busy} />
          </label>
          <label className="missingShiftWide">Note <small>Optional</small>
            <textarea name="note" rows={2} disabled={busy} placeholder="Example: Employee missed both punches" />
          </label>
          <p className="missingShiftHint missingShiftWide">When clock-out is earlier than clock-in, Corner Ops automatically saves it on the following calendar day. Humanity may continue operating past midnight after all.</p>
          <div className="missingShiftActions missingShiftWide">
            <button className="primary" disabled={busy || loadingEmployees || !setup?.employees.length}>{busy ? "Adding shift…" : "Add shift & recalculate"}</button>
            <button type="button" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </form>
      </div>}
    </div>
  </section>;
}

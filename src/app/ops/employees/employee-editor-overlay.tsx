"use client";

import { responseMessage } from "@/app/client-http";
import { FormEvent, useEffect, useRef, useState } from "react";
import { CORNER_DELI_POSITIONS } from "@/lib/business-positions";
import type { Business } from "@/lib/types";
import { useModalFocus } from "@/app/use-modal-focus";
import "./employee-editor-overlay.css";

type Employee = {
  id: string;
  business: Business;
  email: string;
  phone: string;
  smsOptIn: boolean;
  name: string;
  position: string;
  roleGroup: "Driver" | "In-House" | "Ignore";
  countsForTips: boolean;
  hourlyRate: number;
  tippedRate: number;
  active: boolean;
  pinEnabled: boolean;
  scheduleColor: string;
};


function selectedBusiness(): Business {
  const text = document.querySelector<HTMLButtonElement>(".wfBusinessSwitch button.selected")?.textContent?.trim();
  return text === "Tiki" ? "Tiki" : "Corner Deli";
}

async function fetchEmployees(business: Business): Promise<Employee[]> {
  const response = await fetch(`/api/employee-directory?business=${encodeURIComponent(business)}`, { cache: "no-store" });
  if (!response.ok) throw new Error(await responseMessage(response));
  const payload = await response.json() as { employees?: Employee[] };
  return (payload.employees || []).map((employee) => ({ ...employee, business }));
}

export default function EmployeeEditorOverlay() {
  const [business, setBusiness] = useState<Business>("Corner Deli");
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [selected, setSelected] = useState<Employee | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [toast, setToast] = useState("");
  const employeesRef = useRef<Employee[]>([]);
  const businessRef = useRef<Business>(business);
  const employeeModalRef = useModalFocus<HTMLElement>(Boolean(selected), () => { if (!busy) setSelected(null); });

  function storeEmployees(rows: Employee[]) {
    employeesRef.current = rows;
    setEmployees(rows);
  }

  async function load(activeBusiness: Business) {
    const rows = await fetchEmployees(activeBusiness);
    if (businessRef.current === activeBusiness) storeEmployees(rows);
    return rows;
  }

  useEffect(() => {
    const syncBusiness = () => {
      const next = selectedBusiness();
      if (next === businessRef.current && employeesRef.current.length) return;
      businessRef.current = next;
      setBusiness(next);
      setSelected(null);
      void load(next).catch((error) => setToast(error instanceof Error ? error.message : "Employees could not be loaded."));
    };

    const openEmployee = (event: MouseEvent) => {
      const target = event.target as Element | null;
      const card = target?.closest<HTMLElement>(".employeeIdentityCard");
      if (!card || target?.closest("button, input, select, textarea, a, form")) return;
      const name = card.querySelector("header strong")?.textContent?.trim();
      if (!name) return;
      const employee = employeesRef.current.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
      if (employee) {
        setNotice("");
        setSelected(employee);
      }
    };

    const observer = new MutationObserver(syncBusiness);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
    document.addEventListener("click", openEmployee, true);
    syncBusiness();

    return () => {
      document.removeEventListener("click", openEmployee, true);
      observer.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    employeesRef.current = employees;
  }, [employees]);

  async function saveEmployee(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const form = new FormData(event.currentTarget);
    const employeeBusiness = selected.business;
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/employee-directory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update-profile",
          business: employeeBusiness,
          id: selected.id,
          name: String(form.get("name") || ""),
          email: String(form.get("email") || ""),
          phone: String(form.get("phone") || ""),
          smsOptIn: form.get("smsOptIn") === "on",
          position: String(form.get("position") || ""),
          roleGroup: employeeBusiness === "Tiki" ? String(form.get("roleGroup") || "In-House") : undefined,
          countsForTips: form.get("countsForTips") === "on",
          hourlyRate: Number(form.get("hourlyRate") || 0),
          tippedRate: Number(form.get("tippedRate") || 0),
          active: form.get("active") === "on",
          scheduleColor: String(form.get("scheduleColor") || selected.scheduleColor),
          pin: String(form.get("pin") || "") || undefined,
        }),
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      await load(employeeBusiness);
      setSelected(null);
      setToast(`${selected.name}'s employee record was updated.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Employee information could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  return <>
    {toast && <div className="employeeEditorToast" role="status"><span>{toast}</span><button type="button" onClick={() => setToast("")}>×</button></div>}
    {selected && <div className="employeeEditorBackdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setSelected(null); }}>
      <section ref={employeeModalRef} tabIndex={-1} className="employeeEditorModal" role="dialog" aria-modal="true" aria-labelledby="employee-editor-title">
        <header>
          <div><p>Edit employee</p><h2 id="employee-editor-title">{selected.name}</h2><span>{selected.business}</span></div>
          <button type="button" aria-label="Close employee editor" disabled={busy} onClick={() => setSelected(null)}>×</button>
        </header>
        <form onSubmit={saveEmployee} key={`${selected.business}-${selected.id}`}>
          <div className="employeeEditorGrid">
            <label>Name<input name="name" defaultValue={selected.name} required /></label>
            <label>Email<input name="email" type="email" defaultValue={selected.email} /></label>
            <label>Mobile phone<input name="phone" type="tel" defaultValue={selected.phone} /></label>
            <label>Schedule color<input name="scheduleColor" type="color" defaultValue={selected.scheduleColor} /></label>
            <label>Default scheduling position{selected.business === "Corner Deli"
              ? <select name="position" defaultValue={selected.position} required>{CORNER_DELI_POSITIONS.map((position) => <option key={position}>{position}</option>)}</select>
              : <input name="position" defaultValue={selected.position} required />}</label>
            {selected.business === "Tiki" && <label>Payroll role group<select name="roleGroup" defaultValue={selected.roleGroup}><option>In-House</option><option>Driver</option><option>Ignore</option></select></label>}
            <label>Regular hourly rate<input name="hourlyRate" type="number" min="0" step="0.01" defaultValue={selected.hourlyRate} required /></label>
            <label>{selected.business === "Corner Deli" ? "Delivery tipped rate" : "Tipped hourly rate"}<input name="tippedRate" type="number" min="0" step="0.01" defaultValue={selected.tippedRate} required /></label>
            <label>New PIN <small>Leave blank to keep current PIN</small><input name="pin" inputMode="numeric" autoComplete="new-password" /></label>
          </div>

          <div className="employeeEditorChecks">
            <label><input name="active" type="checkbox" defaultChecked={selected.active} /> Active employee</label>
            <label><input name="countsForTips" type="checkbox" defaultChecked={selected.countsForTips} /> Include in eligible tip pools</label>
            <label><input name="smsOptIn" type="checkbox" defaultChecked={selected.smsOptIn} /> Employee consented to SMS notifications</label>
          </div>

          <div className="employeeEditorSourceNote">
            {selected.business === "Corner Deli"
              ? "The position above is the employee's scheduling default. Actual payroll position and delivery classification continue to come from each Rezku-imported shift."
              : "Tiki payroll uses the employee record and Tiki time-clock entries because Tiki shifts are not imported from Rezku."}
          </div>

          {notice && <div className="employeeEditorNotice">{notice}</div>}
          <footer><button type="button" disabled={busy} onClick={() => setSelected(null)}>Cancel</button><button type="submit" className="primary" disabled={busy}>{busy ? "Saving…" : "Save employee"}</button></footer>
        </form>
      </section>
    </div>}
  </>;
}

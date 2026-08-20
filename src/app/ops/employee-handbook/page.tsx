"use client";

import { useEffect, useMemo, useState } from "react";
import "../control-center.css";
import "./employee-handbook.css";

type HandbookSection = { title: string; paragraphs?: string[]; bullets?: string[] };
type Handbook = {
  title: string;
  version: string;
  effectiveDate: string;
  intro: string[];
  sections: HandbookSection[];
  acknowledgment: string;
};
type EmployeeStatus = {
  employeeId: string;
  employeeName: string;
  position: string;
  active: boolean;
  acknowledged: boolean;
  acknowledgedAt: string | null;
  signatureName: string | null;
  handbookVersion: string;
};
type Payload = { business: string; handbook: Handbook; employees: EmployeeStatus[] };

async function responseMessage(response: Response) {
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  return payload?.error || `Request failed (${response.status}).`;
}

function dateTimeLabel(value: string | null) {
  if (!value) return "Not signed";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not signed";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export default function EmployeeHandbookAdminPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [notice, setNotice] = useState("");
  const [showInactive, setShowInactive] = useState(false);

  async function load() {
    const response = await fetch("/api/employment-handbook", { cache: "no-store" });
    if (!response.ok) throw new Error(await responseMessage(response));
    setData(await response.json() as Payload);
  }

  useEffect(() => {
    void load().catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
  }, []);

  const employees = useMemo(() => data?.employees.filter((employee) => showInactive || employee.active) || [], [data?.employees, showInactive]);
  const active = data?.employees.filter((employee) => employee.active) || [];
  const signed = active.filter((employee) => employee.acknowledged).length;

  return <main className="controlPage handbookAdminPage">
    <header className="controlHeader">
      <div>
        <p className="eyebrow">People operations · policy acknowledgments</p>
        <h1>Corner Deli employee handbook</h1>
        <p>Review the current handbook, see who has acknowledged the exact version, and open the employee-facing pages used by staff.</p>
      </div>
      <div className="controlActions">
        <a href="/ops/employment-forms">Manage employment forms</a>
        <a href="/employee/forms">Employee forms view</a>
        <a href="/employee/handbook">Employee handbook view</a>
      </div>
    </header>

    {notice && <div className="noticeBar">{notice}</div>}
    {!data && <section className="controlCard">Loading handbook status…</section>}

    {data && <>
      <section className="handbookAdminStats">
        <article><span>Active employees</span><strong>{active.length}</strong></article>
        <article><span>Acknowledged current version</span><strong>{signed}</strong></article>
        <article><span>Still required</span><strong>{Math.max(0, active.length - signed)}</strong></article>
        <article><span>Current version</span><strong>{data.handbook.version}</strong></article>
      </section>

      <section className="controlCard handbookStatusCard">
        <div className="handbookStatusHeader">
          <div><p className="eyebrow">Signature status</p><h2>Employee acknowledgments</h2></div>
          <label><input type="checkbox" checked={showInactive} onChange={(event) => setShowInactive(event.target.checked)} /> Show inactive employees</label>
        </div>
        <div className="tableWrap"><table><thead><tr><th>Employee</th><th>Position</th><th>Status</th><th>Signed</th><th>Signature</th><th>Version</th></tr></thead><tbody>
          {employees.map((employee) => <tr key={employee.employeeId}>
            <td><strong>{employee.employeeName}</strong>{!employee.active && <small>Inactive</small>}</td>
            <td>{employee.position}</td>
            <td><span className={`handbookAckStatus ${employee.acknowledged ? "signed" : "pending"}`}>{employee.acknowledged ? "Acknowledged" : "Required"}</span></td>
            <td>{dateTimeLabel(employee.acknowledgedAt)}</td>
            <td>{employee.signatureName || "—"}</td>
            <td>{employee.handbookVersion}</td>
          </tr>)}
          {!employees.length && <tr><td colSpan={6}>No employees found.</td></tr>}
        </tbody></table></div>
      </section>

      <section className="controlCard handbookAdminPreview">
        <div className="handbookPreviewHeader">
          <div><p className="eyebrow">Current employee-facing content</p><h2>{data.handbook.title}</h2><p>Effective {data.handbook.effectiveDate} · version {data.handbook.version}</p></div>
          <button type="button" onClick={() => window.print()}>Print handbook</button>
        </div>
        <div className="handbookPreviewIntro">{data.handbook.intro.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}</div>
        <div className="handbookPreviewSections">{data.handbook.sections.map((section) => <section key={section.title}>
          <h3>{section.title}</h3>
          {section.paragraphs?.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
          {section.bullets?.length ? <ul>{section.bullets.map((bullet) => <li key={bullet}>{bullet}</li>)}</ul> : null}
        </section>)}</div>
        <section className="handbookPreviewAck"><p className="eyebrow">Acknowledgment employees sign</p><p>{data.handbook.acknowledgment}</p></section>
      </section>
    </>}
  </main>;
}

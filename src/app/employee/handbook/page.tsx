"use client";

import { FormEvent, useEffect, useState } from "react";
import "../forms/forms.css";
import "./handbook.css";

type HandbookSection = {
  title: string;
  paragraphs?: string[];
  bullets?: string[];
};

type HandbookDocument = {
  title: string;
  version: string;
  effectiveDate: string;
  intro: string[];
  sections: HandbookSection[];
  acknowledgment: string;
  contentHash: string;
};

type Acknowledgment = {
  signatureName: string;
  acknowledgedAt: string;
  handbookVersion: string;
};

type Payload = {
  employee: { id: string; name: string; business: string; position: string };
  handbook: HandbookDocument;
  acknowledgment: Acknowledgment | null;
};

async function responseMessage(response: Response) {
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  return payload?.error || `Request failed (${response.status}).`;
}

function dateTimeLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export default function EmployeeHandbookPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [unauthorized, setUnauthorized] = useState(false);

  async function load() {
    const response = await fetch("/api/employee/handbook", { cache: "no-store" });
    if (response.status === 401) {
      setUnauthorized(true);
      return;
    }
    if (!response.ok) throw new Error(await responseMessage(response));
    setData(await response.json() as Payload);
  }

  useEffect(() => {
    void load().catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!data || data.acknowledgment) return;
    setBusy(true);
    setNotice("");
    try {
      const form = new FormData(event.currentTarget);
      const response = await fetch("/api/employee/handbook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          attest: form.get("attest") === "on",
          signatureName: String(form.get("signatureName") || ""),
        }),
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      await load();
      setNotice("Handbook acknowledgment signed and recorded.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Handbook acknowledgment failed.");
    } finally {
      setBusy(false);
    }
  }

  if (unauthorized) {
    return <main className="employmentFormsShell handbookShell"><section className="employmentFormsCard"><h1>Employee sign-in required</h1><p>Sign in through Employee Hub to review and acknowledge the handbook.</p><a className="employmentPrimary" href="/employee">Open Employee Hub</a></section></main>;
  }

  if (!data) {
    return <main className="employmentFormsShell handbookShell"><section className="employmentFormsCard"><h1>Loading employee handbook</h1>{notice && <p>{notice}</p>}</section></main>;
  }

  return <main className="employmentFormsShell handbookShell">
    <header className="employmentFormsHero handbookHero">
      <div>
        <p className="employmentEyebrow">{data.employee.business} employee records</p>
        <h1>{data.handbook.title}</h1>
        <p>{data.employee.name} · {data.employee.position}</p>
      </div>
      <div className="handbookHeroActions">
        <button type="button" onClick={() => window.print()}>Print</button>
        <a href="/employee/forms">Employment forms</a>
        <a href="/employee">Employee Hub</a>
      </div>
    </header>

    {notice && <div className="employmentNotice">{notice}</div>}

    <section className="employmentFormsCard handbookDocument">
      <div className="handbookMeta">
        <div><span>Version</span><strong>{data.handbook.version}</strong></div>
        <div><span>Effective</span><strong>{data.handbook.effectiveDate}</strong></div>
        <div><span>Status</span><strong>{data.acknowledgment ? "Acknowledged" : "Signature required"}</strong></div>
      </div>

      <section className="handbookIntro">
        {data.handbook.intro.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
      </section>

      <div className="handbookSections">
        {data.handbook.sections.map((section) => <section className="handbookSection" key={section.title}>
          <h2>{section.title}</h2>
          {section.paragraphs?.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
          {section.bullets?.length ? <ul>{section.bullets.map((bullet) => <li key={bullet}>{bullet}</li>)}</ul> : null}
        </section>)}
      </div>

      <section className="handbookAcknowledgment">
        <p className="employmentEyebrow">Employee acknowledgment</p>
        <h2>Receipt and understanding</h2>
        <p>{data.handbook.acknowledgment}</p>

        {data.acknowledgment ? <div className="handbookSigned">
          <span>Electronically signed by</span>
          <strong>{data.acknowledgment.signatureName}</strong>
          <small>{dateTimeLabel(data.acknowledgment.acknowledgedAt)} · version {data.acknowledgment.handbookVersion}</small>
        </div> : <form className="employmentSignature" onSubmit={submit}>
          <label className="checkbox"><input name="attest" type="checkbox" required /> I reviewed the handbook above and agree to follow the policies and procedures that apply to my work.</label>
          <label>Electronic signature<input name="signatureName" autoComplete="off" placeholder={data.employee.name} required /></label>
          <small>Type your name exactly as shown: <strong>{data.employee.name}</strong>. Your signature records the handbook version, date and time, account, browser, network address, and a hash of the handbook text.</small>
          <button className="employmentPrimary" disabled={busy}>{busy ? "Signing…" : "Sign handbook acknowledgment"}</button>
        </form>}
      </section>
    </section>
  </main>;
}

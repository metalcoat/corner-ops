import "./team.css";
import { headers } from "next/headers";
import { siteBrandForHost } from "@/lib/site-brand";

export default async function TeamHome() {
  const brand = siteBrandForHost((await headers()).get("host") || "");
  return <main className="teamHome">
    <section className="teamHomeCard">
      <img className="teamHomeLogo" src={brand.icon} alt="" />
      <p className="teamEyebrow">{brand.name}</p>
      <h1>Team workspace</h1>
      <p>Sign in to your business account to see your team information.</p>
      <div className="teamHomeLinks">
        <a href="/employee">Employee Hub</a>
        <a href="/ops/messages">Team messages</a>
        <a href="/ops/workforce">Schedules and staff</a>
        <a href="/ops/payroll-control">Payroll control</a>
      </div>
    </section>
  </main>;
}

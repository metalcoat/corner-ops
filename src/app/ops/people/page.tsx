import "../control-center.css";
import "./people.css";

const groups = [
  {
    eyebrow: "Plan and communicate",
    title: "Workforce",
    description: "Build and publish schedules, review time-off and shift requests, and manage day-to-day staffing.",
    links: [
      { label: "Schedule & workforce", href: "/ops/workforce", primary: true },
      { label: "Team messages", href: "/ops/messages" },
      { label: "Employees", href: "/ops/employees" },
    ],
  },
  {
    eyebrow: "Time and exceptions",
    title: "Attendance",
    description: "Review punches, late arrivals, missing clock-outs, corrections, and source-import exceptions.",
    links: [
      { label: "Attendance review", href: "/ops/attendance", primary: true },
      { label: "Rezku delivery monitor", href: "/ops/rezku-monitor" },
      { label: "Tiki employee clock", href: "/clock" },
    ],
  },
  {
    eyebrow: "Calculate and approve",
    title: "Payroll",
    description: "Review hours, tipped hours, tip allocation, overtime, and the final weekly payroll run.",
    links: [
      { label: "Payroll control", href: "/ops/payroll-control", primary: true },
      { label: "Employee Hub", href: "/employee" },
    ],
  },
];

export default function PeoplePage() {
  return <main className="controlPage peoplePage">
    <header className="controlHeader">
      <div>
        <p className="eyebrow">People operations</p>
        <h1>Schedule, attendance, and payroll</h1>
        <p>One organized starting point for the work involving actual humans, who have once again refused to fit neatly into separate navigation pills.</p>
      </div>
      <div className="controlActions"><a href="/ops">Operations</a></div>
    </header>

    <section className="peopleFlow" aria-label="People workflow">
      <span>1. Schedule</span><i>→</i><span>2. Track time</span><i>→</i><span>3. Review payroll</span>
    </section>

    <section className="peopleGrid">
      {groups.map((group) => <article className="controlCard peopleCard" key={group.title}>
        <div>
          <p className="eyebrow">{group.eyebrow}</p>
          <h2>{group.title}</h2>
          <p>{group.description}</p>
        </div>
        <div className="peopleLinks">
          {group.links.map((link) => <a key={link.href} className={link.primary ? "primary" : ""} href={link.href}>{link.label}</a>)}
        </div>
      </article>)}
    </section>
  </main>;
}

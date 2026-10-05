import "./team.css";

export default function TeamHome() {
  return <main className="teamHome">
    <section className="teamHomeCard">
      <p className="teamEyebrow">Corner Ops</p>
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

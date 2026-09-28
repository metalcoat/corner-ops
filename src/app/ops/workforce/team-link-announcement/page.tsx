export default function TeamLinkAnnouncementPage() {
  return (
    <main style={{ maxWidth: 720, margin: "4rem auto", padding: "1.5rem" }}>
      <h1>Corner Deli team link announcement</h1>
      <p>Send this text to active Corner Deli employees who have opted in to SMS:</p>
      <blockquote>Corner Deli team: Our new team site is https://team.ordercornerdeli.com. Use your existing PIN for Employee Hub, schedules, and messages. Reply STOP to opt out.</blockquote>
      <form method="post" action="/api/workforce/team-link-announcement">
        <button type="submit">Send Corner Deli SMS</button>
      </form>
    </main>
  );
}

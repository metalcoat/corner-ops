export const metadata = {
  title: "SMS Help | Corner Deli",
};

export default function SmsHelpPage() {
  return (
    <main style={{ maxWidth: 820, margin: "0 auto", padding: "2rem 1.25rem", lineHeight: 1.6 }}>
      <h1>Corner Deli SMS Help</h1>
      <p>
        Corner Deli uses SMS for employee operational communications such as schedules, schedule
        changes, shift reminders, attendance or timekeeping notices, and staffing notices.
      </p>
      <p>
        For help, reply <strong>HELP</strong> to any Corner Deli employee SMS or contact Corner Deli
        at <strong>(315) 393-2271</strong>.
      </p>
      <p>
        To stop SMS messages, reply <strong>STOP</strong>. Message frequency varies. Standard message
        and data rates may apply.
      </p>
      <p><a href="/privacy">SMS Privacy Policy</a> · <a href="/terms">SMS Terms and Conditions</a></p>
    </main>
  );
}

export const metadata = {
  title: "SMS Terms and Conditions | Corner Deli",
};

export default function TermsPage() {
  return (
    <main style={{ maxWidth: 820, margin: "0 auto", padding: "2rem 1.25rem", lineHeight: 1.6 }}>
      <h1>Corner Deli SMS Terms and Conditions</h1>
      <p><strong>Effective date:</strong> August 17, 2026</p>
      <p>
        The Corner Deli employee SMS program provides work-related operational notifications,
        including schedules, schedule changes, shift reminders, attendance or timekeeping notices,
        staffing notices, and similar workplace communications.
      </p>

      <h2>Consent</h2>
      <p>
        Employees may opt in to receive SMS notifications by providing a mobile number and giving
        affirmative consent during onboarding or while updating their employee communication
        preferences. SMS participation is optional and is not required to access scheduling or
        other workplace information.
      </p>

      <h2>Message frequency and charges</h2>
      <p>
        Message frequency varies based on scheduling and workplace activity. Standard message and
        data rates may apply according to the employee&apos;s wireless plan.
      </p>

      <h2>Opt out</h2>
      <p>
        Reply <strong>STOP</strong> to opt out. After opting out, no further program messages will be
        sent unless the employee opts in again. Employees may continue to access work information
        through Corner Ops, the Employee Portal, or their manager.
      </p>

      <h2>Help</h2>
      <p>
        Reply <strong>HELP</strong> for help. Employees may also contact Corner Deli at
        (315) 393-2271.
      </p>

      <h2>Privacy</h2>
      <p>
        Mobile information and SMS consent are not sold or shared with third parties or affiliates
        for marketing or promotional purposes. See the <a href="/privacy">SMS Privacy Policy</a> for
        additional information.
      </p>

      <h2>Service availability</h2>
      <p>
        SMS delivery depends on wireless carriers and network availability and is not guaranteed.
        Corner Deli may modify or discontinue the SMS program while continuing to provide workplace
        information through other available channels.
      </p>

      <p><a href="/privacy">SMS Privacy Policy</a> · <a href="/sms-help">SMS Help</a></p>
    </main>
  );
}

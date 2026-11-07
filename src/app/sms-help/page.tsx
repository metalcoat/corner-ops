import PolicyPage from "../policy-page/policy-page";
import { publicPageMetadata } from "../policy-page/metadata";

export function generateMetadata() {
  return publicPageMetadata("/sms-help");
}

export default function SmsHelpPage() {
  return (
    <PolicyPage>
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
    </PolicyPage>
  );
}

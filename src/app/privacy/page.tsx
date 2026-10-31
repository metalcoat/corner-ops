import PolicyPage from "../policy-page/policy-page";

export const metadata = {
  title: "Privacy Policy | Corner Deli",
};

export default function PrivacyPage() {
  return (
    <PolicyPage>
      <h1>Corner Deli Privacy Policy</h1>
      <p><strong>Effective date:</strong> October 26, 2026 (online ordering); August 17, 2026 (SMS program)</p>

      <h2>Online ordering</h2>
      <p>
        When you order from Corner Deli online or by phone we collect what we need to make and deliver
        your order: your name, phone number, email address if you give it, delivery address and notes, the
        items you order, and your order history and rewards. We use it to prepare, deliver and confirm
        your order, to contact you about it, to keep your account and rewards, and to keep our records.
      </p>
      <p>
        <strong>Payment security.</strong> Card payments are processed by our payment processor over an
        encrypted (HTTPS) connection. Corner Deli never receives or stores your full card number or
        security code. If you choose to save a card, it is stored by our payment processor and we keep only
        the card type, last four digits and expiration date so you can pick it next time; you can remove it
        from your account at any time.
      </p>
      <p>
        We do not sell your information. We share it only with service providers that help us run ordering
        (payment processing, address lookup and maps, text and email delivery, sign-in with Google), only as
        needed for that service. The site uses a sign-in cookie to keep you logged in. To ask about or
        correct your information, call (315) 393-2271, email{" "}
        <a href="mailto:bills@ordercornerdeli.com">bills@ordercornerdeli.com</a>, or visit us at 828 Morris St,
        Ogdensburg, NY 13669. Corner Deli is operated by Mike&apos;s Corner Deli, LLC.
      </p>

      <h2>Text message (SMS) program</h2>
      <p>
        Corner Deli uses Corner Ops to send employees operational text messages related to work,
        including schedules, schedule changes, shift reminders, attendance or timekeeping notices,
        staffing notices, and other employment-related operational communications.
      </p>

      <h2>Information we collect</h2>
      <p>
        For this SMS program, we may collect an employee&apos;s name, mobile phone number, SMS consent
        status, and information needed to provide the relevant workplace notification.
      </p>

      <h2>How we use SMS information</h2>
      <p>
        Mobile numbers and SMS consent information are used only to provide workplace operational
        communications and to administer the employee messaging program.
      </p>
      <p>
        <strong>
          Mobile information, including phone numbers and SMS opt-in consent, will not be sold,
          rented, or shared with third parties or affiliates for marketing or promotional purposes.
        </strong>
      </p>
      <p>
        Information may be provided to service providers, such as telecommunications providers,
        only as reasonably necessary to transmit and operate the requested messaging service.
      </p>

      <h2>Opting out</h2>
      <p>
        Participation in SMS notifications is optional. Employees may reply <strong>STOP</strong> to
        opt out of SMS messages. Employees who opt out can continue to obtain scheduling and other
        workplace information through Corner Ops, the Employee Portal, or their manager.
      </p>

      <h2>Help</h2>
      <p>
        Reply <strong>HELP</strong> for assistance. Employees may also contact Corner Deli at
        (315) 393-2271.
      </p>

      <h2>Data retention and security</h2>
      <p>
        We retain employee contact and messaging records only as reasonably necessary for business,
        employment, compliance, and operational purposes. We use reasonable administrative and
        technical safeguards designed to protect this information.
      </p>

      <h2>Changes</h2>
      <p>
        This policy may be updated when the employee messaging program changes. The effective date
        above reflects the current version.
      </p>

      <p><a href="/terms">SMS Terms and Conditions</a> · <a href="/sms-help">SMS Help</a></p>
    </PolicyPage>
  );
}

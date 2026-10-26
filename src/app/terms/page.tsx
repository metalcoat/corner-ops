import PolicyPage from "../policy-page/policy-page";

export const metadata = {
  title: "Terms and Conditions | Corner Deli",
};

export default function TermsPage() {
  return (
    <PolicyPage>
      <h1>Corner Deli Terms and Conditions</h1>
      <p><strong>Effective date:</strong> October 26, 2026 (online ordering); August 17, 2026 (SMS program)</p>

      <h2>Online ordering</h2>
      <p>
        Corner Deli, 828 Morris St, Ogdensburg, NY 13669, (315) 393-2271, sells the food and drinks shown on
        this site for pickup or delivery. Prices are in U.S. dollars and include sales tax; delivery fees,
        any delivery minimum and the total are shown before you place your order. Menu items, prices and
        availability can change; the price shown when you place your order is the price you pay.
      </p>
      <p>
        By placing an order you confirm the details are correct and authorize the charge to your card, or
        agree to pay at pickup or delivery where that is offered. Orders are subject to our{" "}
        <a href="/refund-policy">Refund &amp; Cancellation Policy</a> (all sales are final) and our{" "}
        <a href="/delivery-policy">Delivery &amp; Pickup Policy</a>. Your information is handled as described
        in our <a href="/privacy">Privacy Policy</a>. We may refuse or cancel an order we cannot fulfil; if
        we do, any payment for it is returned.
      </p>

      <h2>Text message (SMS) program</h2>
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
    </PolicyPage>
  );
}

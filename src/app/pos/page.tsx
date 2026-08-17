import { orderingBusinessConfigs } from "@/lib/ordering-business-config";
import "./pos.css";
import "./pos-separation.css";

export default function PosDevelopmentHome() {
  const deli = orderingBusinessConfigs["Corner Deli"];
  const tiki = orderingBusinessConfigs.Tiki;

  return <main className="posDevHome">
    <section className="posDevHomeCard">
      <span className="posDevBadge">DEVELOPMENT · AUTO DEPLOY OFF</span>
      <p className="posDevEyebrow">Replacement POS build</p>
      <h1>Separate POS applications</h1>
      <p>
        The deli and Tiki share lower-level ordering infrastructure, but their POS screens,
        features, operational workflows, and reporting stay business-specific. This development
        area is intentionally separate from the live Corner Ops application until parallel testing begins.
      </p>
      <div className="posDevChoices">
        <a href={deli.posPath}>
          <strong>Corner Deli POS</strong>
          <span>Pickup, delivery, drivers, deli inventory, and deli-only reporting. No bar tabs.</span>
        </a>
        <a href={tiki.posPath}>
          <strong>Tiki POS</strong>
          <span>Bar service, tabs, Tiki inventory, and Tiki-only reporting. No deli driver workflow.</span>
        </a>
        <a href="/pos/deli/settings">
          <strong>Deli delivery & tax settings</strong>
          <span>Edit the delivery minimum, mileage bands, fees, tax-inclusive mode, and current tax rate.</span>
        </a>
      </div>
      <a className="posDevExit" href="/ops/people">Return to live-style Corner Ops area</a>
    </section>
  </main>;
}

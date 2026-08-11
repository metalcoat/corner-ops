import type { Business } from "@/lib/types";
import { orderingBusinessConfig } from "@/lib/ordering-business-config";
import "./pos.css";
import "./pos-separation.css";

export default function PosReports({ business }: { business: Business }) {
  const config = orderingBusinessConfig(business);

  return <main className="posReportPage">
    <header className="posReportHeader">
      <div>
        <span className="posDevBadge">DEVELOPMENT · SEPARATE REPORTING</span>
        <p className="posDevEyebrow">{business} POS reports</p>
        <h1>{business} reporting</h1>
        <p>
          This reporting surface is permanently scoped to {business}. It will use the shared reporting
          engine underneath, but will not combine sales, tenders, labor, drivers, tabs, inventory, or
          closeout totals with the other business unless an owner intentionally opens a separate consolidated report.
        </p>
      </div>
      <a href={config.posPath}>Back to {business} POS</a>
    </header>

    <section className="posReportGrid">
      <article><strong>Sales</strong><span>Net/gross sales, discounts, comps, tax, refunds, and order counts.</span></article>
      <article><strong>Tenders</strong><span>Cash, card, house account, gift card, store credit, and settlement reconciliation.</span></article>
      <article><strong>Inventory</strong><span>Usage, adjustments, waste, receiving, counts, and estimated loss.</span></article>
      {config.features.drivers && <article><strong>Delivery / Drivers</strong><span>Delivery orders, driver assignments, cash turn-in, tips, and settlement.</span></article>}
      {config.features.barTabs && <article><strong>Bar / Tabs</strong><span>Open/closed tabs, bartender ownership, preauthorizations, transfers, and end-of-night exceptions.</span></article>}
      <article><strong>Closeout</strong><span>Register sessions, expected cash, counted cash, over/short, and business-day closeout.</span></article>
    </section>
  </main>;
}

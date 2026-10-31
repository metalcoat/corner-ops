"use client";
import { useState } from "react";
import BulkCashVoidPanel from "../../orders/bulk-cash-void-panel";

export default function BulkCashVoidSettings() {
  const [open, setOpen] = useState(false);
  return <section className="posSettingsCard">
    <p className="posDevEyebrow">Owner only</p>
    <h2>Bulk void cash orders</h2>
    <p>Voids cash-paid orders in a date range and reverses their cash. Development only.</p>
    <button type="button" onClick={() => setOpen(true)}>BULK VOID CASH ORDERS</button>
    {open && <div className="ocPage ocPanelHost"><BulkCashVoidPanel onClose={() => setOpen(false)} onComplete={async () => {}} /></div>}
  </section>;
}

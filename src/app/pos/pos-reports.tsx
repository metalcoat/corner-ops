import type { Business } from "@/lib/types";
import "./pos.css";
import "./pos-separation.css";

export default function PosReports({ business }: { business: Business }) {
  return <main className="posReportPage">
    <header className="posReportHeader"><div>
      <span className="posDevBadge">DEVELOPMENT</span>
      <p className="posDevEyebrow">{business} POS reports</p>
      <h1>Reports are not implemented yet</h1>
      <p>This workspace is reserved for the future authorized reporting workflow. No sales or tender figures are being estimated or displayed.</p>
    </div></header>
  </main>;
}

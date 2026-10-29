import type { Metadata } from "next";
import ScreenGate from "../screen-gate";
import StoreDashboard from "../deli/dashboard/store-dashboard";
import "../deli/dashboard/store-dashboard.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Store dashboard | Corner Deli" };

/** Full-screen store dashboard (no POS menu): car tracking, phone, orders. Signs in once like the status board. */
export default function DashboardPage() {
  return (
    <ScreenGate kind="board" title="Store dashboard" returnTo="/pos/dashboard">
      <StoreDashboard />
    </ScreenGate>
  );
}

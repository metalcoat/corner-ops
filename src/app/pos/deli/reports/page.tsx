import PosReports from "../../pos-reports";
import { getPosSession } from "@/lib/pos-auth";
import ManagerAccessGate from "../manager-access-gate";
import AiPhoneReport from "./ai-phone-report";
import Link from "next/link";
import "./reports.css";

export default async function DeliPosReportsPage() {
  const session = await getPosSession(true);
  if (!session) return <ManagerAccessGate />;
  if (session.posRole !== "manager" && session.posRole !== "owner") return <ManagerAccessGate denied />;
  return <><section className="posReportCard reportOperations"><h2>Register & inventory</h2><p>Back-of-house controls and current stock.</p><nav aria-label="Register and inventory"><Link href="/pos/deli/register">SET TILL / REGISTER</Link><Link href="/pos/deli/inventory">INVENTORY</Link><Link href="/pos/deli/inventory/costs">SUPPLIER COSTS</Link><Link href="/employee/stock">STOCK SHEET</Link></nav></section><PosReports business="Corner Deli" /><AiPhoneReport /></>;
}
